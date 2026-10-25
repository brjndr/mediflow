import type pg from 'pg';
import type {
  LabRejectReasonValue,
  LabResultFlagValue,
  LabResultStatusValue,
  LabSampleStatusValue,
  LabStageValue,
} from './schemas.js';

/**
 * The laboratory SQL. Every statement runs on the request's own transaction under the app role,
 * so row-level security limits it to the active hospital: no statement here names a tenant. The
 * worklist reads the orders, patients and catalog it lists; orders are only ever changed through
 * the clinical module's `moveLabOrder`.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SampleRow {
  id: string;
  tenant_id: string;
  order_id: string;
  encounter_id: string;
  patient_id: string;
  lab_test_id: string;
  accession_id: string;
  sample_type: string;
  container: string | null;
  status: LabSampleStatusValue;
  collected_at: Date;
  collected_by_name: string;
  received_at: Date | null;
  received_by_name: string | null;
  rejected_at: Date | null;
  rejected_by_name: string | null;
  reject_reason: LabRejectReasonValue | null;
  reject_note: string | null;
  version: number;
  /** The calendar day at the hospital it was collected on, which ranges are read for. */
  collected_on: string;
}

const SAMPLE_COLUMNS = `s.id, s.tenant_id, s.order_id, s.encounter_id, s.patient_id, s.lab_test_id,
  s.accession_id, s.sample_type, s.container, s.status, s.collected_at,
  coalesce(cu.name, '') as collected_by_name, s.received_at, ru.name as received_by_name,
  s.rejected_at, xu.name as rejected_by_name, s.reject_reason, s.reject_note, s.version,
  (s.collected_at at time zone tn.timezone)::date::text as collected_on`;

const SAMPLE_JOINS = `join tenants tn on tn.id = s.tenant_id
  left join users cu on cu.id = s.collected_by
  left join users ru on ru.id = s.received_by
  left join users xu on xu.id = s.rejected_by`;

export async function findSample(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<SampleRow | null> {
  if (!UUID.test(id)) return null;
  if (forUpdate) {
    const locked = await client.query('select 1 from lab_samples where id = $1 for update', [id]);
    if (locked.rowCount !== 1) return null;
  }
  const { rows } = await client.query<SampleRow>(
    `select ${SAMPLE_COLUMNS} from lab_samples s ${SAMPLE_JOINS} where s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** The order's sample that is not rejected, if there is one. */
export async function standingSample(
  client: pg.ClientBase,
  orderId: string,
): Promise<SampleRow | null> {
  const { rows } = await client.query<SampleRow>(
    `select ${SAMPLE_COLUMNS} from lab_samples s ${SAMPLE_JOINS}
     where s.order_id = $1 and s.status <> 'rejected'`,
    [orderId],
  );
  return rows[0] ?? null;
}

/**
 * The next accession id of the hospital day: `YYMMDD-NNNN`. One counter row per hospital and
 * day, counted in the same statement that takes the number, so two collections at the same
 * moment wait for each other; a refused collection rolls its number back.
 */
export async function nextAccessionId(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ day: string; last_number: number }>(
    `insert into lab_accession_counters as c (tenant_id, day, last_number)
     select id, (now() at time zone timezone)::date, 1 from tenants where id = app_tenant_id()
     on conflict (tenant_id, day) do update set last_number = c.last_number + 1
     returning to_char(day, 'YYMMDD') as day, last_number`,
  );
  const row = rows[0];
  if (!row) throw new Error('no accession number was taken');
  return `${row.day}-${String(row.last_number).padStart(4, '0')}`;
}

export interface NewSample {
  orderId: string;
  encounterId: string;
  patientId: string;
  labTestId: string;
  accessionId: string;
  sampleType: string;
  container: string | null;
}

export async function insertSample(
  client: pg.ClientBase,
  sample: NewSample,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into lab_samples (tenant_id, order_id, encounter_id, patient_id, lab_test_id,
                              accession_id, sample_type, container, collected_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      sample.orderId,
      sample.encounterId,
      sample.patientId,
      sample.labTestId,
      sample.accessionId,
      sample.sampleType,
      sample.container,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('sample was not inserted');
  return id;
}

export async function receiveSample(client: pg.ClientBase, id: string, userId: string) {
  await client.query(
    `update lab_samples set status = 'received', received_at = now(), received_by = $2
     where id = $1`,
    [id, userId],
  );
}

export async function rejectSample(
  client: pg.ClientBase,
  id: string,
  userId: string,
  reason: LabRejectReasonValue,
  note: string | null,
) {
  await client.query(
    `update lab_samples set status = 'rejected', rejected_at = now(), rejected_by = $2,
       reject_reason = $3, reject_note = $4
     where id = $1`,
    [id, userId, reason, note],
  );
}

export async function hasResults(client: pg.ClientBase, sampleId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from lab_results where sample_id = $1 limit 1',
    [sampleId],
  );
  return (rowCount ?? 0) > 0;
}

/** Whom a result is read for: the patient's sex and date of birth. */
export async function patientForRanges(
  client: pg.ClientBase,
  patientId: string,
): Promise<{ gender: string; dob: string } | null> {
  const { rows } = await client.query<{ gender: string; dob: string }>(
    'select gender, dob::text as dob from patients where id = $1',
    [patientId],
  );
  return rows[0] ?? null;
}

/** Who and what a lab order is for, as the results page heads it (#91). */
export async function orderHeading(
  client: pg.ClientBase,
  orderId: string,
): Promise<{
  patient_name: string;
  patient_mrn: string;
  item_name: string;
  priority: string;
} | null> {
  const { rows } = await client.query<{
    patient_name: string;
    patient_mrn: string;
    item_name: string;
    priority: string;
  }>(
    `select p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
       o.item_name, o.priority
     from orders o join patients p on p.tenant_id = o.tenant_id and p.id = o.patient_id
     where o.id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

// ----- Worklist ----------------------------------------------------------------------------------

export interface WorkItemRow {
  order_id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  patient_dob: string;
  lab_test_id: string;
  item_code: string | null;
  item_name: string;
  priority: 'routine' | 'urgent' | 'stat';
  instructions: string | null;
  placed_at: Date;
  ordered_by_name: string;
  order_status: 'placed' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  sample_type: string;
  container: string | null;
  stage: LabStageValue;
  sample_id: string | null;
  rejected_samples: number;
  results_entered: number;
  results_to_verify: number;
  rank: number;
  cursor_at: string;
}

interface Cursor {
  r: number;
  a: string;
  i: string;
}

// The sort time in UTC to the microsecond, whatever the session's DateStyle.
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const encodeCursor = (row: WorkItemRow) =>
  Buffer.from(
    JSON.stringify({ r: row.rank, a: row.cursor_at, i: row.order_id } satisfies Cursor),
  ).toString('base64url');

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { r, a, i } = value as Record<string, unknown>;
    if (r !== 0 && r !== 1 && r !== 2) return null;
    if (typeof a !== 'string' || !CURSOR_AT.test(a)) return null;
    if (typeof i !== 'string' || !UUID.test(i)) return null;
    return { r, a, i };
  } catch {
    return null;
  }
}

/**
 * The hospital's lab orders, each with its newest sample, its stage and how far its results are.
 * Open orders sort by priority, then the oldest first (`placed_at`); completed ones the newest
 * completed first (`status_changed_at`), each through its own partial index.
 */
const workItems = (completed: boolean) => `
  select o.id as order_id, o.tenant_id, o.encounter_id, o.patient_id,
    p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
    p.dob::text as patient_dob, o.lab_test_id, o.item_code, o.item_name, o.priority,
    o.instructions, o.placed_at, coalesce(u.name, '') as ordered_by_name,
    o.status as order_status, t.sample_type, t.container,
    case when o.status = 'completed' then 'completed'
      when s.id is null or s.status = 'rejected' then 'to_collect' else s.status end as stage,
    s.id as sample_id,
    (select count(*) from lab_samples r where r.order_id = o.id and r.status = 'rejected')::int
      as rejected_samples,
    coalesce(c.entered, 0)::int as results_entered, coalesce(c.to_verify, 0)::int as results_to_verify,
    ${completed ? '0' : "case o.priority when 'stat' then 0 when 'urgent' then 1 else 2 end"} as rank,
    ${completed ? 'o.status_changed_at' : 'o.placed_at'} as sort_at,
    to_char(${completed ? 'o.status_changed_at' : 'o.placed_at'} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
  from orders o
  join patients p on p.tenant_id = o.tenant_id and p.id = o.patient_id
  join lab_tests t on t.tenant_id = o.tenant_id and t.id = o.lab_test_id
  left join users u on u.id = o.ordered_by
  left join lateral (
    select s.id, s.status from lab_samples s
    where s.tenant_id = o.tenant_id and s.order_id = o.id
    order by s.collected_at desc, s.id desc limit 1
  ) s on true
  left join lateral (
    select count(*) as entered, count(*) filter (where r.status = 'entered') as to_verify
    from lab_results r
    where r.tenant_id = o.tenant_id and r.sample_id = s.id and s.status <> 'rejected'
      and not exists (
        select from lab_results a where a.tenant_id = r.tenant_id and a.amends_id = r.id
      )
  ) c on true
  where o.type = 'lab'
    and ${completed ? "o.status = 'completed'" : "o.status not in ('cancelled', 'completed')"}
    and ($1::text is null or o.priority = $1)`;

export interface Worklist {
  rows: WorkItemRow[];
  nextCursor: string | null;
  total?: number;
}

/**
 * One page of the worklist at a stage: open orders stat, urgent, routine, the oldest first;
 * completed ones the newest completed first, with no `total` (they only grow). Null for a bad cursor.
 */
export async function listWorklist(
  client: pg.ClientBase,
  filters: { stage: LabStageValue; priority?: string; cursor?: string; limit: number },
): Promise<Worklist | null> {
  const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
  if (after === null) return null;
  const completed = filters.stage === 'completed';
  const { rows } = await client.query<WorkItemRow>(
    completed
      ? `select * from (${workItems(true)}) w
         where ($3::int is null or (w.sort_at, w.order_id) < ($4::timestamptz, $5::uuid))
           and $2::text = 'completed'
         order by w.sort_at desc, w.order_id desc
         limit $6`
      : `select * from (${workItems(false)}) w
         where w.stage = $2
           and ($3::int is null or (w.rank, w.sort_at, w.order_id) > ($3, $4::timestamptz, $5::uuid))
         order by w.rank, w.sort_at, w.order_id
         limit $6`,
    [
      filters.priority ?? null,
      filters.stage,
      after?.r ?? null,
      after?.a ?? null,
      after?.i ?? null,
      filters.limit + 1,
    ],
  );
  const more = rows.length > filters.limit;
  const page = more ? rows.slice(0, filters.limit) : rows;
  const last = page.at(-1);
  const list: Worklist = { rows: page, nextCursor: more && last ? encodeCursor(last) : null };
  if (after === undefined && !completed) {
    const counted = await client.query<{ total: number }>(
      `select count(*)::int as total from (${workItems(false)}) w where w.stage = $2`,
      [filters.priority ?? null, filters.stage],
    );
    list.total = counted.rows[0]?.total ?? 0;
  }
  return list;
}

export async function samplesByIds(
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<Map<string, SampleRow>> {
  const byId = new Map<string, SampleRow>();
  if (ids.length === 0) return byId;
  const { rows } = await client.query<SampleRow>(
    `select ${SAMPLE_COLUMNS} from lab_samples s ${SAMPLE_JOINS} where s.id = any($1::uuid[])`,
    [ids],
  );
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

// ----- Results -----------------------------------------------------------------------------------

export interface ResultRow {
  id: string;
  tenant_id: string;
  sample_id: string;
  order_id: string;
  encounter_id: string;
  patient_id: string;
  lab_test_id: string;
  test_code: string;
  test_name: string;
  result_type: 'numeric' | 'text';
  value_number: string | null;
  value_text: string | null;
  unit: string | null;
  range_low: number | null;
  range_high: number | null;
  range_critical_low: number | null;
  range_critical_high: number | null;
  range_note: string | null;
  flag: LabResultFlagValue | null;
  comment: string | null;
  status: LabResultStatusValue;
  entered_at: Date;
  entered_by: string;
  entered_by_name: string;
  verified_at: Date | null;
  verified_by_name: string | null;
  amends_id: string | null;
  amendment_reason: string | null;
  amended_by_id: string | null;
  version: number;
}

const RESULTS = `select r.id, r.tenant_id, r.sample_id, r.order_id, r.encounter_id, r.patient_id, r.lab_test_id,
    r.test_code, r.test_name, r.result_type, r.value_number::text as value_number, r.value_text,
    r.unit, r.range_low, r.range_high, r.range_critical_low, r.range_critical_high, r.range_note,
    r.flag, r.comment, r.status, r.entered_at, r.entered_by, coalesce(eu.name, '') as entered_by_name,
    r.verified_at, vu.name as verified_by_name, r.amends_id, r.amendment_reason,
    (select a.id from lab_results a where a.tenant_id = r.tenant_id and a.amends_id = r.id)
      as amended_by_id,
    r.version
  from lab_results r
  left join users eu on eu.id = r.entered_by
  left join users vu on vu.id = r.verified_by`;

/** Every result of a sample, corrections included, oldest first. */
export async function resultsOf(client: pg.ClientBase, sampleId: string): Promise<ResultRow[]> {
  const { rows } = await client.query<ResultRow>(
    `${RESULTS} where r.sample_id = $1 order by r.entered_at, r.id`,
    [sampleId],
  );
  return rows;
}

export async function findResult(client: pg.ClientBase, id: string): Promise<ResultRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<ResultRow>(`${RESULTS} where r.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface NewResult {
  sampleId: string;
  orderId: string;
  encounterId: string;
  patientId: string;
  labTestId: string;
  testCode: string;
  testName: string;
  resultType: 'numeric' | 'text';
  valueNumber: string | null;
  valueText: string | null;
  unit: string | null;
  range: {
    low?: number;
    high?: number;
    criticalLow?: number;
    criticalHigh?: number;
    note?: string;
  } | null;
  flag: LabResultFlagValue | null;
  comment: string | null;
  amendsId: string | null;
  amendmentReason: string | null;
}

export async function insertResult(
  client: pg.ClientBase,
  result: NewResult,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into lab_results (tenant_id, sample_id, order_id, encounter_id, patient_id, lab_test_id, test_code,
                              test_name, result_type, value_number, value_text, unit, range_low,
                              range_high, range_critical_low, range_critical_high, range_note,
                              flag, comment, amends_id, amendment_reason, entered_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21)
     returning id`,
    [
      result.sampleId,
      result.orderId,
      result.encounterId,
      result.patientId,
      result.labTestId,
      result.testCode,
      result.testName,
      result.resultType,
      result.valueNumber,
      result.valueText,
      result.unit,
      result.range?.low ?? null,
      result.range?.high ?? null,
      result.range?.criticalLow ?? null,
      result.range?.criticalHigh ?? null,
      result.range?.note ?? null,
      result.flag,
      result.comment,
      result.amendsId,
      result.amendmentReason,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('result was not inserted');
  return id;
}

export async function verifyResult(client: pg.ClientBase, id: string, userId: string) {
  await client.query(
    "update lab_results set status = 'verified', verified_at = now(), verified_by = $2 where id = $1",
    [id, userId],
  );
}
