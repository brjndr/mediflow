import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';
import type { RichTextDocument } from '../../core/http/rich-text.js';
import type {
  EncounterStatusValue,
  EncounterTypeValue,
  OrderStatusValue,
  OrderTypeValue,
} from './schemas.js';

/**
 * The clinical SQL. Every statement runs on the request's own transaction under the app role, so
 * row-level security limits it to the active hospital. A child of an encounter (a note, a
 * diagnosis, an order, a prescription) is found by its id, then its encounter within the caller's
 * scope: the encounter decides who may see what is attached to it.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who may be seen: the scope the caller holds the permission with, and who the caller is. */
export interface Visibility {
  scope: PermissionScope;
  userId: string;
}

// `own` is the encounters the caller attends as a doctor; `department` those of the departments
// the caller's active doctor profile is in. Someone with no profile sees nothing under either.
const visible = (scope: string, user: string) =>
  `(${scope}::text = 'all'
    or (${scope}::text = 'own' and d.user_id::text = ${user}::text)
    or (${scope}::text = 'department' and e.department_id in (
          select o.department_id from doctors o where o.user_id::text = ${user}::text and o.active)))`;

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

interface Cursor {
  a: string;
  i: string;
}

// A timestamp as Postgres writes one, so a cursor keeps its microseconds.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { a, i } = value as Record<string, unknown>;
    if (typeof a !== 'string' || !PG_TIMESTAMP.test(a)) return null;
    if (typeof i !== 'string' || !UUID.test(i)) return null;
    return { a, i };
  } catch {
    return null;
  }
}

/**
 * One page of `query` (a select whose last clause is a `where`), ordered by `at` then `id`,
 * newest first or oldest first. Null for a bad cursor.
 */
async function paged<Row extends { id: string }>(
  client: pg.ClientBase,
  query: {
    sql: string;
    values: unknown[];
    at: string;
    id: string;
    newestFirst: boolean;
    /** Count the rows for `total` on the first page. Default true. */
    count?: boolean;
  },
  cursor: string | undefined,
  limit: number,
): Promise<Page<Row> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const { sql, values, at, id, newestFirst, count = true } = query;
  if (!/^select /.test(sql)) throw new Error('paged needs a select');
  const n = values.length;
  const direction = newestFirst ? 'desc' : 'asc';
  // The cursor's time in UTC to the microsecond, whatever the session's DateStyle.
  const withCursor = sql.replace(
    /^select /,
    `select to_char(${at} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as cursor_at, `,
  );
  const { rows } = await client.query<Row & { cursor_at: string }>(
    `${withCursor}
       and ($${n + 1}::timestamptz is null
            or (${at}, ${id}) ${newestFirst ? '<' : '>'} ($${n + 1}::timestamptz, $${n + 2}::uuid))
     order by ${at} ${direction}, ${id} ${direction}
     limit $${n + 3}`,
    [...values, after?.a ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: Page<Row> = {
    rows: page,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ a: last.cursor_at, i: last.id } satisfies Cursor)).toString(
            'base64url',
          )
        : null,
  };
  if (after === undefined && count) {
    const counted = await client.query<{ total: number }>(
      `select count(*)::int as total from (${sql}) s`,
      values,
    );
    result.total = counted.rows[0]?.total ?? 0;
  }
  return result;
}

const empty = <Row>(cursor: string | undefined): Page<Row> => ({
  rows: [],
  nextCursor: null,
  ...(cursor === undefined ? { total: 0 } : {}),
});

// ---------------------------------------------------------------------------------------------
// Encounters

export interface EncounterRow {
  id: string;
  tenant_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  type: 'opd' | 'ipd' | 'er' | 'daycare';
  status: EncounterStatusValue;
  appointment_id: string | null;
  queue_token_id: string | null;
  attending_doctor_id: string | null;
  attending_doctor_name: string | null;
  department_id: string | null;
  department_name: string | null;
  opened_at: Date;
  opened_by_name: string;
  ended_at: Date | null;
  ended_by_name: string | null;
  cancel_reason: string | null;
  version: number;
}

const ENCOUNTERS = `select e.id, e.tenant_id, e.patient_id,
                           p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
                           e.type, e.status, e.appointment_id, e.queue_token_id,
                           e.attending_doctor_id, du.name as attending_doctor_name,
                           e.department_id, dp.name as department_name,
                           e.opened_at, coalesce(ou.name, '') as opened_by_name,
                           e.ended_at, eu.name as ended_by_name, e.cancel_reason, e.version
                    from encounters e
                    join patients p on p.id = e.patient_id
                    left join doctors d on d.id = e.attending_doctor_id
                    left join users du on du.id = d.user_id
                    left join departments dp on dp.id = e.department_id
                    left join users ou on ou.id = e.opened_by
                    left join users eu on eu.id = e.ended_by`;

export interface EncounterFilters {
  patientId?: string;
  attendingDoctorId?: string;
  status?: EncounterStatusValue;
  type?: EncounterTypeValue;
  cursor?: string;
  limit: number;
}

/** The encounters the caller may see, newest first. Null for a bad cursor. */
export async function listEncounters(
  client: pg.ClientBase,
  filters: EncounterFilters,
  visibility: Visibility,
): Promise<Page<EncounterRow> | null> {
  // An id that is not one matches nothing, as another hospital's does.
  for (const id of [filters.patientId, filters.attendingDoctorId]) {
    if (id !== undefined && !UUID.test(id)) {
      return filters.cursor === undefined || decodeCursor(filters.cursor)
        ? empty(filters.cursor)
        : null;
    }
  }
  return paged<EncounterRow>(
    client,
    {
      sql: `${ENCOUNTERS}
            where ($1::uuid is null or e.patient_id = $1)
              and ($2::uuid is null or e.attending_doctor_id = $2)
              and ($3::text is null or e.status = $3)
              and ($4::text is null or e.type = $4)
              and ${visible('$5', '$6')}`,
      values: [
        filters.patientId ?? null,
        filters.attendingDoctorId ?? null,
        filters.status ?? null,
        filters.type ?? null,
        visibility.scope,
        visibility.userId,
      ],
      at: 'e.opened_at',
      id: 'e.id',
      newestFirst: true,
      // A whole hospital's encounters are not counted on every first page: only one patient's
      // or one doctor's.
      count: filters.patientId !== undefined || filters.attendingDoctorId !== undefined,
    },
    filters.cursor,
    filters.limit,
  );
}

/**
 * One encounter the caller may see, or null. `lock` takes the row: `update` for a change of the
 * encounter itself, `share` while something is added to it, so it cannot close meanwhile.
 */
export async function findEncounter(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility,
  lock?: 'update' | 'share',
): Promise<EncounterRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<EncounterRow>(
    `${ENCOUNTERS} where e.id = $1 and ${visible('$2', '$3')}${lock ? ` for ${lock} of e` : ''}`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

export interface Doctor {
  id: string;
  department_id: string;
}

/**
 * A doctor who practises here now (the profile and the membership active), within the scope the
 * caller opens encounters with: `own` only themselves, `department` their department's. Null for
 * anyone else, of this hospital or another.
 */
export async function practisingDoctor(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility,
): Promise<Doctor | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<Doctor>(
    `select d.id, d.department_id
     from doctors d join memberships m on m.user_id = d.user_id
     where d.id = $1 and d.active and m.status = 'active'
       and ($2::text = 'all'
            or ($2::text = 'own' and d.user_id::text = $3::text)
            or ($2::text = 'department' and d.department_id in (
                  select o.department_id from doctors o where o.user_id::text = $3::text and o.active)))`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

/** The caller's own active doctor profile here, or null. */
export async function ownDoctorId(client: pg.ClientBase, userId: string): Promise<string | null> {
  if (!UUID.test(userId)) return null;
  const { rows } = await client.query<{ id: string }>(
    'select id from doctors where user_id = $1 and active',
    [userId],
  );
  return rows[0]?.id ?? null;
}

export interface NewEncounter {
  patientId: string;
  appointmentId: string | null;
  queueTokenId: string | null;
  doctor: Doctor;
}

export async function insertEncounter(
  client: pg.ClientBase,
  encounter: NewEncounter,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into encounters (tenant_id, patient_id, type, appointment_id, queue_token_id,
                             attending_doctor_id, department_id, opened_by)
     values (app_tenant_id(), $1, 'opd', $2, $3, $4, $5, $6)
     returning id`,
    [
      encounter.patientId,
      encounter.appointmentId,
      encounter.queueTokenId,
      encounter.doctor.id,
      encounter.doctor.department_id,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('encounter was not inserted');
  return id;
}

/**
 * The encounters, not cancelled, that a token or an appointment already opened, found by the
 * unique indexes' keys: none, one, or two when each link opened its own.
 */
export async function encounterOpenedFor(
  client: pg.ClientBase,
  link: { queueTokenId: string | null; appointmentId: string | null },
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select id from encounters
     where status <> 'cancelled'
       and (queue_token_id = $1::uuid or appointment_id = $2::uuid)`,
    [link.queueTokenId, link.appointmentId],
  );
  return rows.map((row) => row.id);
}

export async function endEncounter(
  client: pg.ClientBase,
  id: string,
  status: 'closed' | 'cancelled',
  userId: string,
  reason: string | null,
): Promise<void> {
  await client.query(
    `update encounters set status = $2, ended_at = now(), ended_by = $3, cancel_reason = $4
     where id = $1`,
    [id, status, userId, reason],
  );
}

/** Whether any note of the encounter is still a draft. */
export async function hasDrafts(client: pg.ClientBase, encounterId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "select 1 from clinical_notes where encounter_id = $1 and status = 'draft' limit 1",
    [encounterId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Whether anything of the encounter is on the record: a signed note, a diagnosis that stands,
 * an order not cancelled or a prescription. A cancelled encounter must have none.
 */
export async function hasRecords(client: pg.ClientBase, encounterId: string): Promise<boolean> {
  const { rows } = await client.query<{ any: boolean }>(
    `select exists (select 1 from clinical_notes where encounter_id = $1 and status = 'signed')
         or exists (select 1 from encounter_diagnoses where encounter_id = $1 and retracted_at is null)
         or exists (select 1 from orders where encounter_id = $1 and status <> 'cancelled')
         or exists (select 1 from prescriptions where encounter_id = $1) as any`,
    [encounterId],
  );
  return rows[0]?.any ?? false;
}

// ---------------------------------------------------------------------------------------------
// Notes

export interface NoteRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  status: 'draft' | 'signed';
  body: unknown;
  author_id: string;
  author_name: string;
  created_at: Date;
  updated_at: Date;
  signed_at: Date | null;
  amends_id: string | null;
  amendment_reason: string | null;
  amended_by_id: string | null;
  version: number;
}

const NOTES = `select n.id, n.tenant_id, n.encounter_id, n.patient_id, n.status, n.body,
                      n.author_id, coalesce(u.name, '') as author_name, n.created_at, n.updated_at,
                      n.signed_at, n.amends_id, n.amendment_reason, a.id as amended_by_id, n.version
               from clinical_notes n
               left join users u on u.id = n.author_id
               left join clinical_notes a on a.amends_id = n.id`;

/** The encounter's signed notes and the caller's own drafts, oldest first. */
export async function listNotes(
  client: pg.ClientBase,
  encounterId: string,
  userId: string,
  page: { cursor?: string; limit: number },
): Promise<Page<NoteRow> | null> {
  return paged<NoteRow>(
    client,
    {
      sql: `${NOTES} where n.encounter_id = $1 and (n.status = 'signed' or n.author_id::text = $2::text)`,
      values: [encounterId, userId],
      at: 'n.created_at',
      id: 'n.id',
      newestFirst: false,
    },
    page.cursor,
    page.limit,
  );
}

/** A note, signed or the caller's own draft, or null. `forUpdate` locks it. */
export async function findNote(
  client: pg.ClientBase,
  id: string,
  userId: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<NoteRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<NoteRow>(
    `${NOTES} where n.id = $1 and (n.status = 'signed' or n.author_id::text = $2::text)
     ${forUpdate ? 'for update of n' : ''}`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function insertNote(
  client: pg.ClientBase,
  note: {
    encounterId: string;
    patientId: string;
    body: RichTextDocument;
    amendsId: string | null;
    amendmentReason: string | null;
  },
  userId: string,
): Promise<string> {
  // An amendment is signed as it is written.
  const { rows } = await client.query<{ id: string }>(
    `insert into clinical_notes (tenant_id, encounter_id, patient_id, body, author_id,
                                 status, signed_at, amends_id, amendment_reason)
     values (app_tenant_id(), $1, $2, $3, $4,
             case when $5::uuid is null then 'draft' else 'signed' end,
             case when $5::uuid is null then null else now() end, $5, $6)
     returning id`,
    [note.encounterId, note.patientId, note.body, userId, note.amendsId, note.amendmentReason],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('note was not inserted');
  return id;
}

export async function saveDraft(
  client: pg.ClientBase,
  id: string,
  body: RichTextDocument,
): Promise<void> {
  await client.query('update clinical_notes set body = $2 where id = $1', [id, body]);
}

export async function signNote(client: pg.ClientBase, id: string): Promise<void> {
  await client.query(
    "update clinical_notes set status = 'signed', signed_at = now() where id = $1",
    [id],
  );
}

export async function deleteDraft(client: pg.ClientBase, id: string): Promise<void> {
  await client.query("delete from clinical_notes where id = $1 and status = 'draft'", [id]);
}

// ---------------------------------------------------------------------------------------------
// Diagnoses

export interface DiagnosisRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  code_id: string | null;
  code: string | null;
  code_title: string | null;
  text: string | null;
  kind: 'provisional' | 'final';
  recorded_at: Date;
  recorded_by_name: string;
  retracted_at: Date | null;
  retracted_by_name: string | null;
  retraction_reason: string | null;
}

const DIAGNOSES = `select g.id, g.tenant_id, g.encounter_id, g.patient_id, g.code_id, g.code,
                          g.code_title, g.text, g.kind, g.recorded_at,
                          coalesce(ru.name, '') as recorded_by_name, g.retracted_at,
                          tu.name as retracted_by_name, g.retraction_reason
                   from encounter_diagnoses g
                   left join users ru on ru.id = g.recorded_by
                   left join users tu on tu.id = g.retracted_by`;

export async function listDiagnoses(
  client: pg.ClientBase,
  encounterId: string,
  page: { cursor?: string; limit: number },
): Promise<Page<DiagnosisRow> | null> {
  return paged<DiagnosisRow>(
    client,
    {
      sql: `${DIAGNOSES} where g.encounter_id = $1`,
      values: [encounterId],
      at: 'g.recorded_at',
      id: 'g.id',
      newestFirst: false,
    },
    page.cursor,
    page.limit,
  );
}

export async function findDiagnosis(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<DiagnosisRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<DiagnosisRow>(
    `${DIAGNOSES} where g.id = $1 ${forUpdate ? 'for update of g' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertDiagnosis(
  client: pg.ClientBase,
  diagnosis: {
    encounterId: string;
    patientId: string;
    code: { id: string; code: string; title: string } | null;
    text: string | null;
    kind: 'provisional' | 'final';
  },
  userId: string,
): Promise<string> {
  const { code } = diagnosis;
  const { rows } = await client.query<{ id: string }>(
    `insert into encounter_diagnoses (tenant_id, encounter_id, patient_id, code_id, code,
                                      code_title, text, kind, recorded_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      diagnosis.encounterId,
      diagnosis.patientId,
      code?.id ?? null,
      code?.code ?? null,
      code?.title ?? null,
      diagnosis.text,
      diagnosis.kind,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('diagnosis was not inserted');
  return id;
}

export async function retractDiagnosis(
  client: pg.ClientBase,
  id: string,
  reason: string,
  userId: string,
): Promise<void> {
  await client.query(
    `update encounter_diagnoses
     set retracted_at = now(), retracted_by = $2, retraction_reason = $3
     where id = $1`,
    [id, userId, reason],
  );
}

// ---------------------------------------------------------------------------------------------
// Orders

export interface OrderRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  type: OrderTypeValue;
  lab_test_id: string | null;
  service_id: string | null;
  drug_id: string | null;
  prescription_id: string | null;
  line_number: number | null;
  item_code: string | null;
  item_name: string | null;
  status: OrderStatusValue;
  priority: 'routine' | 'urgent' | 'stat';
  instructions: string | null;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  duration_days: number | null;
  quantity: number | null;
  placed_at: Date;
  ordered_by: string;
  ordered_by_name: string;
  status_changed_at: Date | null;
  cancel_reason: string | null;
  version: number;
}

const ORDERS = `select o.id, o.tenant_id, o.encounter_id, o.patient_id, o.type, o.lab_test_id,
                       o.service_id, o.drug_id, o.prescription_id, o.line_number, o.item_code, o.item_name,
                       o.status, o.priority, o.instructions, o.dose, o.route, o.frequency,
                       o.duration_days, o.quantity, o.placed_at, o.ordered_by,
                       coalesce(u.name, '') as ordered_by_name, o.status_changed_at,
                       o.cancel_reason, o.version
                from orders o
                left join users u on u.id = o.ordered_by`;

export async function listOrders(
  client: pg.ClientBase,
  encounterId: string,
  filters: { type?: OrderTypeValue; cursor?: string; limit: number },
): Promise<Page<OrderRow> | null> {
  return paged<OrderRow>(
    client,
    {
      sql: `${ORDERS} where o.encounter_id = $1 and ($2::text is null or o.type = $2)`,
      values: [encounterId, filters.type ?? null],
      at: 'o.placed_at',
      id: 'o.id',
      newestFirst: false,
    },
    filters.cursor,
    filters.limit,
  );
}

export async function findOrder(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<OrderRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<OrderRow>(
    `${ORDERS} where o.id = $1 ${forUpdate ? 'for update of o' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/** The lines of prescriptions, in the order they were written. */
export async function ordersOfPrescriptions(
  client: pg.ClientBase,
  prescriptionIds: string[],
): Promise<OrderRow[]> {
  if (prescriptionIds.length === 0) return [];
  const { rows } = await client.query<OrderRow>(
    `${ORDERS} where o.prescription_id = any($1::uuid[]) order by o.prescription_id, o.line_number`,
    [prescriptionIds],
  );
  return rows;
}

export interface NewOrder {
  encounterId: string;
  patientId: string;
  type: OrderTypeValue;
  labTestId?: string;
  serviceId?: string;
  drugId?: string;
  prescriptionId?: string;
  lineNumber?: number;
  itemCode: string | null;
  itemName: string | null;
  priority: 'routine' | 'urgent' | 'stat';
  instructions: string | null;
  dose?: string;
  route?: string;
  frequency?: string;
  durationDays?: number;
  quantity?: number;
}

export async function insertOrder(
  client: pg.ClientBase,
  order: NewOrder,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into orders (tenant_id, encounter_id, patient_id, type, lab_test_id, service_id,
                         drug_id, prescription_id, line_number, item_code, item_name, priority,
                         instructions, dose, route, frequency, duration_days, quantity, ordered_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18)
     returning id`,
    [
      order.encounterId,
      order.patientId,
      order.type,
      order.labTestId ?? null,
      order.serviceId ?? null,
      order.drugId ?? null,
      order.prescriptionId ?? null,
      order.lineNumber ?? null,
      order.itemCode,
      order.itemName,
      order.priority,
      order.instructions,
      order.dose ?? null,
      order.route ?? null,
      order.frequency ?? null,
      order.durationDays ?? null,
      order.quantity ?? null,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('order was not inserted');
  return id;
}

export async function setOrderStatus(
  client: pg.ClientBase,
  id: string,
  status: OrderStatusValue,
  userId: string,
  cancelReason: string | null = null,
): Promise<void> {
  await client.query(
    'update orders set status = $2, status_changed_by = $3, cancel_reason = $4 where id = $1',
    [id, status, userId, cancelReason],
  );
}

/**
 * Cancels the lines of a prescription that have not started (placed or accepted), as the one
 * that replaces it is written, with the replacement's reason, and gives the lines cancelled.
 * Lines in progress or completed stay.
 */
export async function cancelOpenLines(
  client: pg.ClientBase,
  prescriptionId: string,
  userId: string,
  reason: string,
): Promise<OrderRow[]> {
  const { rows } = await client.query<{ id: string }>(
    `update orders set status = 'cancelled', status_changed_by = $2, cancel_reason = $3
     where prescription_id = $1 and status in ('placed', 'accepted')
     returning id`,
    [prescriptionId, userId, reason],
  );
  if (rows.length === 0) return [];
  const cancelled = await client.query<OrderRow>(
    `${ORDERS} where o.id = any($1::uuid[]) order by o.line_number`,
    [rows.map((row) => row.id)],
  );
  return cancelled.rows;
}

// ---------------------------------------------------------------------------------------------
// Prescriptions

export interface PrescriptionRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  prescribed_at: Date;
  prescribed_by: string;
  prescribed_by_name: string;
  advice: string | null;
  replaces_id: string | null;
  replace_reason: string | null;
  replaced_by_id: string | null;
}

const PRESCRIPTIONS = `select r.id, r.tenant_id, r.encounter_id, r.patient_id, r.prescribed_at,
                              r.prescribed_by, coalesce(u.name, '') as prescribed_by_name,
                              r.advice, r.replaces_id, r.replace_reason, n.id as replaced_by_id
                       from prescriptions r
                       left join users u on u.id = r.prescribed_by
                       left join prescriptions n on n.replaces_id = r.id`;

export async function listPrescriptions(
  client: pg.ClientBase,
  encounterId: string,
  page: { cursor?: string; limit: number },
): Promise<Page<PrescriptionRow> | null> {
  return paged<PrescriptionRow>(
    client,
    {
      sql: `${PRESCRIPTIONS} where r.encounter_id = $1`,
      values: [encounterId],
      at: 'r.prescribed_at',
      id: 'r.id',
      newestFirst: false,
    },
    page.cursor,
    page.limit,
  );
}

export async function findPrescription(
  client: pg.ClientBase,
  id: string,
): Promise<PrescriptionRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<PrescriptionRow>(`${PRESCRIPTIONS} where r.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertPrescription(
  client: pg.ClientBase,
  prescription: {
    encounterId: string;
    patientId: string;
    advice: string | null;
    replacesId: string | null;
    replaceReason: string | null;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into prescriptions (tenant_id, encounter_id, patient_id, prescribed_by, advice,
                                replaces_id, replace_reason)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning id`,
    [
      prescription.encounterId,
      prescription.patientId,
      userId,
      prescription.advice,
      prescription.replacesId,
      prescription.replaceReason,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('prescription was not inserted');
  return id;
}
