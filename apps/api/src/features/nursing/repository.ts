import type pg from 'pg';

/**
 * The SQL of nursing and ward care. Every statement runs on the request's own transaction under
 * the app role, so row-level security limits it to the active hospital: no statement names a
 * tenant. The stay (admission, encounter, patient) is looked up through `features/admissions`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A timestamp as Postgres writes one, so a cursor keeps its microseconds.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
export const isUuid = (value: string): boolean => UUID.test(value);

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
}

interface Cursor {
  t: string;
  i: string;
}

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { t, i } = value as Record<string, unknown>;
    if (typeof t !== 'string' || !PG_TIMESTAMP.test(t)) return null;
    if (typeof i !== 'string' || !UUID.test(i)) return null;
    return { t, i };
  } catch {
    return null;
  }
}

/** The instant to the microsecond in UTC, whatever the session's DateStyle, for a cursor. */
export const exact = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;

export interface Keyed {
  id: string;
  cursor_t: string;
}

/**
 * Newest first by a time column, then id. `where` holds the filter on `$1...`; the cursor's
 * parameters follow it. Null for a cursor that is not ours.
 */
export async function newestFirst<Row extends Keyed>(
  client: pg.ClientBase,
  select: string,
  column: string,
  where: string,
  params: unknown[],
  paging: { cursor?: string | undefined; limit: number },
): Promise<Page<Row> | null> {
  const values = [...params];
  let after = '';
  if (paging.cursor !== undefined) {
    const cursor = decodeCursor(paging.cursor);
    if (!cursor) return null;
    values.push(cursor.t, cursor.i);
    after = ` and (${column}, x.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
  }
  const { rows } = await client.query<Row>(
    `${select} where ${where}${after} order by ${column} desc, x.id desc limit ${paging.limit + 1}`,
    values,
  );
  const more = rows.length > paging.limit;
  const page = more ? rows.slice(0, paging.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: more && last ? encodeCursor({ t: last.cursor_t, i: last.id }) : null,
  };
}

// --- vital signs -------------------------------------------------------------------------------

export interface WardVitalRow {
  id: string;
  tenant_id: string;
  admission_id: string;
  encounter_id: string;
  patient_id: string;
  observed_at: Date;
  recorded_at: Date;
  recorded_by: string;
  recorded_by_name: string;
  systolic: number | null;
  diastolic: number | null;
  pulse: number | null;
  temperature: number | null;
  spo2: number | null;
  weight: number | null;
  height: number | null;
  corrects_id: string | null;
  correction_reason: string | null;
  corrected_by_id: string | null;
  cursor_t: string;
}

const VITALS = `
  select x.id, x.tenant_id, x.admission_id, x.encounter_id, x.patient_id, x.observed_at,
         x.recorded_at, x.recorded_by, coalesce(u.name, '') as recorded_by_name,
         x.systolic, x.diastolic, x.pulse, x.temperature::float8 as temperature, x.spo2,
         x.weight::float8 as weight, x.height::float8 as height, x.corrects_id,
         x.correction_reason,
         (select c.id from ward_vitals c where c.tenant_id = x.tenant_id and c.corrects_id = x.id)
           as corrected_by_id,
         ${exact('x.observed_at')} as cursor_t
  from ward_vitals x
  left join users u on u.id = x.recorded_by`;

export const listWardVitals = (
  client: pg.ClientBase,
  admissionId: string,
  paging: { cursor?: string | undefined; limit: number },
) =>
  newestFirst<WardVitalRow>(
    client,
    VITALS,
    'x.observed_at',
    'x.admission_id = $1',
    [admissionId],
    paging,
  );

export async function findWardVital(
  client: pg.ClientBase,
  id: string,
  admissionId?: string,
): Promise<WardVitalRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<WardVitalRow>(
    `${VITALS} where x.id = $1 and ($2::uuid is null or x.admission_id = $2)`,
    [id, admissionId ?? null],
  );
  return rows[0] ?? null;
}

export interface NewWardVital {
  admissionId: string;
  encounterId: string;
  patientId: string;
  observedAt: Date;
  measures: Record<string, number>;
  correctsId?: string;
  correctionReason?: string;
}

const MEASURE_COLUMNS = [
  'systolic',
  'diastolic',
  'pulse',
  'temperature',
  'spo2',
  'weight',
  'height',
] as const;

export async function insertWardVital(
  client: pg.ClientBase,
  reading: NewWardVital,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into ward_vitals (tenant_id, admission_id, encounter_id, patient_id, observed_at,
                              recorded_by, ${MEASURE_COLUMNS.join(', ')}, corrects_id,
                              correction_reason)
     values (app_tenant_id(), $1, $2, $3, $4, $5, ${MEASURE_COLUMNS.map((_, n) => `$${n + 6}`).join(', ')},
             $${MEASURE_COLUMNS.length + 6}, $${MEASURE_COLUMNS.length + 7})
     returning id`,
    [
      reading.admissionId,
      reading.encounterId,
      reading.patientId,
      reading.observedAt,
      userId,
      ...MEASURE_COLUMNS.map((name) => reading.measures[name] ?? null),
      reading.correctsId ?? null,
      reading.correctionReason ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('reading was not recorded');
  return id;
}

// --- the medication chart ----------------------------------------------------------------------

export interface MarEntryRow {
  id: string;
  tenant_id: string;
  admission_id: string;
  encounter_id: string;
  patient_id: string;
  order_id: string;
  drug_id: string;
  scheduled_at: Date;
  outcome: 'given' | 'withheld' | 'refused' | 'missed';
  dose_given: string | null;
  route: string | null;
  reason: string | null;
  administered_at: Date | null;
  recorded_at: Date;
  recorded_by: string;
  recorded_by_name: string;
  witness_by: string | null;
  corrects_id: string | null;
  corrected_by_id: string | null;
  cursor_t: string;
}

const ENTRIES = `
  select x.id, x.tenant_id, x.admission_id, x.encounter_id, x.patient_id, x.order_id, x.drug_id,
         x.scheduled_at, x.outcome, x.dose_given, x.route, x.reason, x.administered_at,
         x.recorded_at, x.recorded_by, coalesce(u.name, '') as recorded_by_name, x.witness_by,
         x.corrects_id,
         (select c.id from mar_entries c where c.tenant_id = x.tenant_id and c.corrects_id = x.id)
           as corrected_by_id,
         ${exact('x.scheduled_at')} as cursor_t
  from mar_entries x
  left join users u on u.id = x.recorded_by`;

export const listMarEntries = (
  client: pg.ClientBase,
  admissionId: string,
  filter: { orderId?: string | undefined; cursor?: string | undefined; limit: number },
) =>
  newestFirst<MarEntryRow>(
    client,
    ENTRIES,
    'x.scheduled_at',
    'x.admission_id = $1 and ($2::uuid is null or x.order_id = $2)',
    [admissionId, filter.orderId && UUID.test(filter.orderId) ? filter.orderId : null],
    filter,
  );

export async function findMarEntry(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<MarEntryRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<MarEntryRow>(
    forUpdate ? `${ENTRIES} where x.id = $1 for update of x` : `${ENTRIES} where x.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface NewMarEntry {
  admissionId: string;
  encounterId: string;
  patientId: string;
  orderId: string;
  drugId: string;
  scheduledAt: Date;
  outcome: string;
  doseGiven: string | null;
  route: string | null;
  reason: string | null;
  administeredAt: Date | null;
  witnessId: string | null;
  correctsId: string | null;
}

export async function insertMarEntry(
  client: pg.ClientBase,
  entry: NewMarEntry,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into mar_entries (tenant_id, admission_id, encounter_id, patient_id, order_id, drug_id,
                              scheduled_at, outcome, dose_given, route, reason, administered_at,
                              recorded_by, witness_by, corrects_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      entry.admissionId,
      entry.encounterId,
      entry.patientId,
      entry.orderId,
      entry.drugId,
      entry.scheduledAt,
      entry.outcome,
      entry.doseGiven,
      entry.route,
      entry.reason,
      entry.administeredAt,
      userId,
      entry.witnessId,
      entry.correctsId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('entry was not recorded');
  return id;
}

/**
 * How many doses of an order stand as given in the 24 hours up to `until`, entries a correction
 * replaced left out. A correction counts when it is given itself.
 */
export async function givenInDay(
  client: pg.ClientBase,
  orderId: string,
  until: Date,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from mar_entries x
     where x.order_id = $1 and x.outcome = 'given'
       and x.scheduled_at > $2::timestamptz - interval '24 hours' and x.scheduled_at <= $2
       and not exists (select 1 from mar_entries c where c.tenant_id = x.tenant_id and c.corrects_id = x.id)`,
    [orderId, until],
  );
  return rows[0]?.n ?? 0;
}

/** Whether a user is an active member of the active hospital. */
export async function activeMember(client: pg.ClientBase, userId: string): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  const { rowCount } = await client.query(
    "select 1 from memberships where tenant_id = app_tenant_id() and user_id = $1 and status = 'active'",
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

// --- progress notes ----------------------------------------------------------------------------

export interface ProgressNoteRow {
  id: string;
  tenant_id: string;
  admission_id: string;
  encounter_id: string;
  patient_id: string;
  kind: 'nursing' | 'handover' | 'observation';
  body: string;
  created_at: Date;
  created_by: string;
  created_by_name: string;
  updated_at: Date;
  updated_by: string;
  version: number;
  cursor_t: string;
}

const NOTES = `
  select x.id, x.tenant_id, x.admission_id, x.encounter_id, x.patient_id, x.kind, x.body,
         x.created_at, x.created_by, coalesce(u.name, '') as created_by_name, x.updated_at,
         x.updated_by, x.version, ${exact('x.created_at')} as cursor_t
  from progress_notes x
  left join users u on u.id = x.created_by`;

export const listProgressNotes = (
  client: pg.ClientBase,
  admissionId: string,
  paging: { cursor?: string | undefined; limit: number },
) =>
  newestFirst<ProgressNoteRow>(
    client,
    NOTES,
    'x.created_at',
    'x.admission_id = $1',
    [admissionId],
    paging,
  );

export async function findProgressNote(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<ProgressNoteRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<ProgressNoteRow>(
    forUpdate ? `${NOTES} where x.id = $1 for update of x` : `${NOTES} where x.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertProgressNote(
  client: pg.ClientBase,
  note: {
    admissionId: string;
    encounterId: string;
    patientId: string;
    kind: string;
    body: string;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into progress_notes (tenant_id, admission_id, encounter_id, patient_id, kind, body,
                                 created_by, updated_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $6)
     returning id`,
    [note.admissionId, note.encounterId, note.patientId, note.kind, note.body, userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('note was not recorded');
  await insertVersion(client, id, 1, note.body, userId);
  return id;
}

async function insertVersion(
  client: pg.ClientBase,
  noteId: string,
  version: number,
  body: string,
  userId: string,
): Promise<void> {
  await client.query(
    `insert into progress_note_versions (tenant_id, note_id, version, body, edited_by)
     values (app_tenant_id(), $1, $2, $3, $4)`,
    [noteId, version, body, userId],
  );
}

/** Changes the text of a note (the caller checked the version) and keeps the new text in history. */
export async function updateProgressNote(
  client: pg.ClientBase,
  id: string,
  body: string,
  userId: string,
): Promise<void> {
  const { rows } = await client.query<{ version: number }>(
    'update progress_notes set body = $2, updated_by = $3 where id = $1 returning version',
    [id, body, userId],
  );
  const version = rows[0]?.version;
  if (version === undefined) throw new Error('note was not changed');
  await insertVersion(client, id, version, body, userId);
}

export interface NoteVersionRow {
  id: string;
  version: number;
  body: string;
  edited_at: Date;
  edited_by: string;
  edited_by_name: string;
  cursor_t: string;
}

/** The versions of a note, newest first. The cursor is the version number. */
export async function listNoteVersions(
  client: pg.ClientBase,
  noteId: string,
  paging: { cursor?: string | undefined; limit: number },
): Promise<Page<NoteVersionRow> | null> {
  let before = 2_000_000_000;
  if (paging.cursor !== undefined) {
    const parsed = /^v(\d{1,9})$/.exec(paging.cursor);
    if (!parsed?.[1]) return null;
    before = Number(parsed[1]);
  }
  const { rows } = await client.query<NoteVersionRow>(
    `select x.id, x.version, x.body, x.edited_at, x.edited_by, coalesce(u.name, '') as edited_by_name,
            '' as cursor_t
     from progress_note_versions x left join users u on u.id = x.edited_by
     where x.note_id = $1 and x.version < $2
     order by x.version desc limit ${paging.limit + 1}`,
    [noteId, before],
  );
  const more = rows.length > paging.limit;
  const page = more ? rows.slice(0, paging.limit) : rows;
  const last = page[page.length - 1];
  return { rows: page, nextCursor: more && last ? `v${last.version}` : null };
}

// --- ward stock requests -----------------------------------------------------------------------

export interface StockRequestRow {
  id: string;
  admission_id: string;
  indent_id: string;
  place_id: string;
  requested_at: Date;
  requested_by: string;
}

export async function insertStockRequest(
  client: pg.ClientBase,
  request: {
    indentId: string;
    admissionId: string;
    encounterId: string;
    patientId: string;
    placeId: string;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into ward_stock_requests (tenant_id, indent_id, admission_id, encounter_id, patient_id,
                                      place_id, requested_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning id`,
    [
      request.indentId,
      request.admissionId,
      request.encounterId,
      request.patientId,
      request.placeId,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('request was not recorded');
  return id;
}

export async function findStockRequest(
  client: pg.ClientBase,
  id: string,
): Promise<StockRequestRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<StockRequestRow>(
    `select id, admission_id, indent_id, place_id, requested_at, requested_by
     from ward_stock_requests where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
