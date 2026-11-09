import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';
import { activeDepartmentsOf } from '../doctors/index.js';
import type {
  AdmissionConsentValue,
  AdmissionStatusValue,
  AttendantRelationValue,
  AdmissionTypeValue,
  BoardBedStatusValue,
  DischargeTypeValue,
  MoveReasonValue,
  ReleaseReasonValue,
} from './schemas.js';

/**
 * The admissions and bed assignments SQL. Every statement runs on the request's own transaction,
 * so row-level security limits it to the active hospital: no statement here names a tenant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A timestamp as Postgres writes one, so a cursor keeps its microseconds.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
export const isUuid = (value: string): boolean => UUID.test(value);

/** Whether an error is the database refusing a row because of this constraint. */
export const refusedBy = (error: unknown, code: string, constraint: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === code &&
  (error as { constraint?: unknown }).constraint === constraint;

/** Who may be seen: the scope the caller holds the permission with, and who the caller is. */
export interface Visibility {
  scope: PermissionScope;
  userId: string;
}

// `own`: the admissions the caller admitted as a doctor. `department`: those of the departments
// the caller's active doctor profile is in. Someone with no profile sees nothing under either.
const visible = (scope: string, user: string) =>
  `(${scope}::text = 'all'
    or (${scope}::text = 'own' and d.user_id::text = ${user}::text)
    or (${scope}::text = 'department' and a.department_id in (${activeDepartmentsOf(user)})))`;

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

type Cursor = Record<string, string>;

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

/** Null for anything that is not a cursor with exactly these keys, each a text. */
function decodeCursor(cursor: string, keys: readonly string[]): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const out: Cursor = {};
    for (const key of keys) {
      const part = record[key];
      if (typeof part !== 'string' || part.length > 200) return null;
      out[key] = part;
    }
    return out;
  } catch {
    return null;
  }
}

// --- admissions --------------------------------------------------------------------------------

export interface AdmissionRow {
  id: string;
  tenant_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  encounter_id: string;
  doctor_id: string;
  doctor_name: string;
  department_id: string;
  department_name: string;
  admission_type: AdmissionTypeValue;
  status: AdmissionStatusValue;
  admitted_at: Date;
  discharged_at: Date | null;
  discharge_type: DischargeTypeValue | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  advice_note: string | null;
  attendant_name: string | null;
  attendant_relation: AttendantRelationValue | null;
  attendant_phone: string | null;
  deposit_minor: string | null;
  consents: AdmissionConsentValue[];
  assignment_id: string | null;
  bed_id: string | null;
  bed_number: string | null;
  ward_id: string | null;
  ward_name: string | null;
  room_name: string | null;
  assigned_at: Date | null;
  version: number;
  order_at: string;
}

const ADMISSIONS = `
  select a.id, a.tenant_id, a.patient_id, p.first_name || ' ' || p.last_name as patient_name,
         p.mrn as patient_mrn, a.encounter_id, a.admitting_doctor_id as doctor_id,
         u.name as doctor_name, a.department_id, dp.name as department_name, a.admission_type,
         a.status, a.admitted_at, a.discharged_at, a.discharge_type,
         a.cancelled_at, a.cancel_reason, a.advice_note, a.attendant_name,
         a.attendant_relation, a.attendant_phone, a.deposit_minor::text as deposit_minor,
         a.consents,
         ba.id as assignment_id, ba.bed_id, b.number as bed_number, ba.ward_id,
         w.name as ward_name, r.name as room_name, ba.assigned_at, a.version,
         to_char(a.admitted_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as order_at
  from admissions a
  join patients p on p.tenant_id = a.tenant_id and p.id = a.patient_id
  join doctors d on d.tenant_id = a.tenant_id and d.id = a.admitting_doctor_id
  join users u on u.id = d.user_id
  join departments dp on dp.tenant_id = a.tenant_id and dp.id = a.department_id
  left join bed_assignments ba
    on ba.tenant_id = a.tenant_id and ba.admission_id = a.id and ba.released_at is null
  left join beds b on b.tenant_id = ba.tenant_id and b.id = ba.bed_id
  left join wards w on w.tenant_id = ba.tenant_id and w.id = ba.ward_id
  left join rooms r on r.tenant_id = b.tenant_id and r.id = b.room_id`;

export interface AdmissionFilter {
  status?: AdmissionStatusValue;
  wardId?: string;
  patientId?: string;
  cursor?: string;
  limit: number;
}

/** One page of admissions, newest first. Null for a bad cursor. */
export async function listAdmissions(
  client: pg.ClientBase,
  filter: AdmissionFilter,
  visibility: Visibility,
): Promise<Page<AdmissionRow> | null> {
  const after = filter.cursor === undefined ? undefined : decodeCursor(filter.cursor, ['a', 'i']);
  if (after === null) return null;
  if (after && (!UUID.test(after.i ?? '') || !PG_TIMESTAMP.test(after.a ?? ''))) return null;
  const params: unknown[] = [visibility.scope, visibility.userId];
  const where = [visible('$1', '$2')];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (filter.status) add('a.status = ?', filter.status);
  if (filter.patientId) {
    if (!UUID.test(filter.patientId)) return { rows: [], nextCursor: null, total: 0 };
    add('a.patient_id = ?::uuid', filter.patientId);
  }
  if (filter.wardId) {
    if (!UUID.test(filter.wardId)) return { rows: [], nextCursor: null, total: 0 };
    add('ba.ward_id = ?::uuid', filter.wardId);
  }
  const filters = params.length;
  const afterClause = after
    ? (params.push(after.a, after.i),
      `and (a.admitted_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`)
    : '';
  params.push(filter.limit + 1);
  const { rows } = await client.query<AdmissionRow>(
    `${ADMISSIONS}
     where ${where.join(' and ')} ${afterClause}
     order by a.admitted_at desc, a.id desc
     limit $${params.length}`,
    params,
  );
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  const result: Page<AdmissionRow> = {
    rows: page,
    nextCursor:
      rows.length > filter.limit && last ? encodeCursor({ a: last.order_at, i: last.id }) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total
       from admissions a
       join doctors d on d.tenant_id = a.tenant_id and d.id = a.admitting_doctor_id
       left join bed_assignments ba
         on ba.tenant_id = a.tenant_id and ba.admission_id = a.id and ba.released_at is null
       where ${where.join(' and ')}`,
      params.slice(0, filters),
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** One admission the caller may see, or null. `forUpdate` locks the admission row. */
export async function findAdmission(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<AdmissionRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<AdmissionRow>(
    `${ADMISSIONS} where a.id = $1 and ${visible('$2', '$3')}${forUpdate ? ' for update of a' : ''}`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

export interface StayRow {
  id: string;
  bed_id: string;
  bed_number: string;
  ward_id: string;
  ward_name: string;
  bed_category_id: string;
  service_id: string | null;
  assigned_at: Date;
  released_at: Date | null;
  release_reason: ReleaseReasonValue | null;
  move_reason: MoveReasonValue | null;
  move_note: string | null;
  day_price_minor: string | null;
}

/** The beds an admission was in, oldest first. */
export async function staysOf(client: pg.ClientBase, admissionId: string): Promise<StayRow[]> {
  const { rows } = await client.query<StayRow>(
    `select ba.id, ba.bed_id, b.number as bed_number, ba.ward_id, w.name as ward_name,
            ba.bed_category_id, ba.service_id, ba.assigned_at, ba.released_at, ba.release_reason,
            ba.move_reason, ba.move_note, price.amount_minor as day_price_minor
     from bed_assignments ba
     join beds b on b.tenant_id = ba.tenant_id and b.id = ba.bed_id
     join wards w on w.tenant_id = ba.tenant_id and w.id = ba.ward_id
     join tenants t on t.id = ba.tenant_id
     left join lateral (
       select sp.amount_minor
       from service_prices sp
       join price_lists pl
         on pl.tenant_id = sp.tenant_id and pl.id = sp.price_list_id and pl.standard
       where sp.tenant_id = ba.tenant_id and sp.service_id = ba.service_id
         and sp.withdrawn_at is null
         and sp.effective_from <= (ba.assigned_at at time zone t.timezone)::date
         and (sp.effective_to is null
              or sp.effective_to >= (ba.assigned_at at time zone t.timezone)::date)
       limit 1
     ) price on true
     where ba.admission_id = $1
     order by ba.assigned_at, ba.id`,
    [admissionId],
  );
  return rows;
}

/** The patient's admission not yet discharged, if any. */
export async function activeAdmissionOf(
  client: pg.ClientBase,
  patientId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "select id from admissions where patient_id = $1 and status = 'admitted'",
    [patientId],
  );
  return rows[0]?.id ?? null;
}

export async function insertAdmission(
  client: pg.ClientBase,
  input: {
    patientId: string;
    encounterId: string;
    doctorId: string;
    departmentId: string;
    admissionType: AdmissionTypeValue;
    adviceNote?: string;
    attendantName?: string;
    attendantRelation?: AttendantRelationValue;
    attendantPhone?: string;
    depositMinor?: number;
    consents?: AdmissionConsentValue[];
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into admissions (tenant_id, patient_id, encounter_id, admitting_doctor_id,
                             department_id, admission_type, admitted_by, advice_note,
                             attendant_name, attendant_relation, attendant_phone,
                             deposit_minor, consents)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      input.patientId,
      input.encounterId,
      input.doctorId,
      input.departmentId,
      input.admissionType,
      userId,
      input.adviceNote ?? null,
      input.attendantName ?? null,
      input.attendantRelation ?? null,
      input.attendantPhone ?? null,
      input.depositMinor ?? null,
      input.consents ?? [],
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('admission was not inserted');
  return id;
}

/** Puts the admission in the bed from now. The caller holds the ward and has moved the bed. */
export async function insertAssignment(
  client: pg.ClientBase,
  input: {
    admissionId: string;
    patientId: string;
    bedId: string;
    wardId: string;
    bedCategoryId: string;
    serviceId: string | null;
    moveReason?: MoveReasonValue | null;
    moveNote?: string | null;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into bed_assignments (tenant_id, admission_id, patient_id, bed_id, ward_id,
                                  bed_category_id, service_id, assigned_by, move_reason, move_note)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      input.admissionId,
      input.patientId,
      input.bedId,
      input.wardId,
      input.bedCategoryId,
      input.serviceId,
      userId,
      input.moveReason ?? null,
      input.moveNote ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('assignment was not inserted');
  return id;
}

/** Ends the admission's open assignment, answering its bed and ward, or null when it has none. */
export async function releaseAssignment(
  client: pg.ClientBase,
  admissionId: string,
  reason: ReleaseReasonValue,
  userId: string,
): Promise<{ id: string; bed_id: string; ward_id: string } | null> {
  const { rows } = await client.query<{ id: string; bed_id: string; ward_id: string }>(
    `update bed_assignments
     set released_at = now(), released_by = $3, release_reason = $2
     where admission_id = $1 and released_at is null
     returning id, bed_id, ward_id`,
    [admissionId, reason, userId],
  );
  return rows[0] ?? null;
}

/** The admission's open assignment, or null while it has no bed. */
export async function openAssignment(
  client: pg.ClientBase,
  admissionId: string,
): Promise<{ id: string; bed_id: string; ward_id: string } | null> {
  const { rows } = await client.query<{ id: string; bed_id: string; ward_id: string }>(
    `select id, bed_id, ward_id from bed_assignments
     where admission_id = $1 and released_at is null`,
    [admissionId],
  );
  return rows[0] ?? null;
}

/** Counts a change of the admission's bed in its version. */
export async function touchAdmission(client: pg.ClientBase, id: string): Promise<void> {
  await client.query('update admissions set updated_at = now() where id = $1', [id]);
}

export async function dischargeAdmission(
  client: pg.ClientBase,
  id: string,
  dischargeType: DischargeTypeValue,
  userId: string,
): Promise<void> {
  await client.query(
    `update admissions
     set status = 'discharged', discharged_at = now(), discharged_by = $3, discharge_type = $2
     where id = $1`,
    [id, dischargeType, userId],
  );
}

/** Cancels an admission made by mistake; final, like a discharge. */
export async function cancelAdmission(
  client: pg.ClientBase,
  id: string,
  reason: string,
  userId: string,
): Promise<void> {
  await client.query(
    `update admissions
     set status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = $2
     where id = $1`,
    [id, reason, userId],
  );
}

// --- the bed board -----------------------------------------------------------------------------

export interface BoardRow {
  id: string;
  number: string;
  ward_id: string;
  ward_name: string;
  room_id: string;
  room_name: string;
  category_name: string;
  status: BoardBedStatusValue;
  blocked_reason: string | null;
  admission_id: string | null;
  patient_id: string | null;
  patient_name: string | null;
  patient_mrn: string | null;
  assigned_at: Date | null;
  version: number;
  ward_lower: string;
  number_lower: string;
}

const BOARD = `
  select b.id, b.number, b.ward_id, w.name as ward_name, b.room_id, r.name as room_name,
         c.name as category_name, b.status, b.blocked_reason, ba.admission_id, ba.patient_id,
         p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
         ba.assigned_at, b.version, w.name_lower as ward_lower, b.number_lower
  from beds b
  join wards w on w.tenant_id = b.tenant_id and w.id = b.ward_id
  join rooms r on r.tenant_id = b.tenant_id and r.id = b.room_id
  join bed_categories c on c.tenant_id = b.tenant_id and c.id = b.bed_category_id
  left join bed_assignments ba
    on ba.tenant_id = b.tenant_id and ba.bed_id = b.id and ba.released_at is null
  left join patients p on p.tenant_id = ba.tenant_id and p.id = ba.patient_id`;

/** One bed as the board shows it, or null. */
export async function boardBed(client: pg.ClientBase, bedId: string): Promise<BoardRow | null> {
  if (!UUID.test(bedId)) return null;
  const { rows } = await client.query<BoardRow>(`${BOARD} where b.id = $1`, [bedId]);
  return rows[0] ?? null;
}

/**
 * One page of the beds in use (not archived, in a ward and a room not archived), by ward name
 * and bed number. Null for a bad cursor.
 */
export async function listBoard(
  client: pg.ClientBase,
  filter: { wardId?: string; status?: BoardBedStatusValue; cursor?: string; limit: number },
): Promise<Page<BoardRow> | null> {
  const after =
    filter.cursor === undefined ? undefined : decodeCursor(filter.cursor, ['w', 'v', 'n', 'i']);
  if (after === null) return null;
  if (after && (!UUID.test(after.v ?? '') || !UUID.test(after.i ?? ''))) return null;
  const params: unknown[] = [];
  const where = ['not b.archived', 'not w.archived', 'not r.archived'];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (filter.wardId) {
    if (!UUID.test(filter.wardId)) return { rows: [], nextCursor: null, total: 0 };
    add('b.ward_id = ?::uuid', filter.wardId);
  }
  if (filter.status) add('b.status = ?', filter.status);
  const filters = params.length;
  let afterClause = '';
  if (after) {
    params.push(after.w, after.v, after.n, after.i);
    const n = params.length;
    afterClause = `and (w.name_lower, b.ward_id, b.number_lower, b.id)
      > ($${n - 3}::text, $${n - 2}::uuid, $${n - 1}::text, $${n}::uuid)`;
  }
  params.push(filter.limit + 1);
  const { rows } = await client.query<BoardRow>(
    `${BOARD}
     where ${where.join(' and ')} ${afterClause}
     order by w.name_lower, b.ward_id, b.number_lower, b.id
     limit $${params.length}`,
    params,
  );
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  const result: Page<BoardRow> = {
    rows: page,
    nextCursor:
      rows.length > filter.limit && last
        ? encodeCursor({ w: last.ward_lower, v: last.ward_id, n: last.number_lower, i: last.id })
        : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total
       from beds b
       join wards w on w.tenant_id = b.tenant_id and w.id = b.ward_id
       join rooms r on r.tenant_id = b.tenant_id and r.id = b.room_id
       where ${where.join(' and ')}`,
      params.slice(0, filters),
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}
