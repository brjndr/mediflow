import type pg from 'pg';
import type { ImagingModalityValue, ImagingStageValue } from './schemas.js';

/**
 * Radiology's SQL. Every statement runs on the request's own transaction under the app role, so
 * row-level security limits it to the active hospital: no statement here names a tenant. The
 * worklist reads the orders, patients and services it lists; orders are only ever changed
 * through the clinical module's `moveImagingOrder`.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StudyRow {
  id: string;
  tenant_id: string;
  order_id: string;
  encounter_id: string;
  patient_id: string;
  modality: ImagingModalityValue;
  scheduled_at: Date | null;
  scheduled_by_name: string | null;
  performed_at: Date | null;
  performed_by_name: string | null;
  version: number;
}

const STUDY_COLUMNS = `st.id, st.tenant_id, st.order_id, st.encounter_id, st.patient_id, st.modality,
  st.scheduled_at, su.name as scheduled_by_name, st.performed_at, pu.name as performed_by_name,
  st.version`;

const STUDY_JOINS = `left join users su on su.id = st.scheduled_by
  left join users pu on pu.id = st.performed_by`;

/** The study of an order, if it has one; `forUpdate` locks it (its order is locked first). */
export async function studyOf(
  client: pg.ClientBase,
  orderId: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<StudyRow | null> {
  if (!UUID.test(orderId)) return null;
  if (forUpdate) {
    await client.query('select 1 from imaging_studies where order_id = $1 for update', [orderId]);
  }
  const { rows } = await client.query<StudyRow>(
    `select ${STUDY_COLUMNS} from imaging_studies st ${STUDY_JOINS} where st.order_id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

export async function studiesByIds(
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<Map<string, StudyRow>> {
  const byId = new Map<string, StudyRow>();
  if (ids.length === 0) return byId;
  const { rows } = await client.query<StudyRow>(
    `select ${STUDY_COLUMNS} from imaging_studies st ${STUDY_JOINS} where st.id = any($1::uuid[])`,
    [ids],
  );
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

/** The modality of an imaging service, `other` when it has none. */
export async function modalityOfService(
  client: pg.ClientBase,
  serviceId: string,
): Promise<ImagingModalityValue> {
  const { rows } = await client.query<{ modality: ImagingModalityValue | null }>(
    'select modality from services where id = $1',
    [serviceId],
  );
  return rows[0]?.modality ?? 'other';
}

/**
 * The end of the window a study may be scheduled in: midnight at the hospital after the last of
 * `days` days ahead, so the whole of the last day is open, as the form offers it.
 */
export async function scheduleWindowEnd(client: pg.ClientBase, days: number): Promise<Date> {
  const { rows } = await client.query<{ window_end: Date }>(
    `select ((date_trunc('day', now() at time zone t.timezone) + make_interval(days => $1 + 1))
       at time zone t.timezone) as window_end
     from tenants t where t.id = app_tenant_id()`,
    [days],
  );
  const row = rows[0];
  if (!row) throw new Error('no hospital');
  return row.window_end;
}

export interface NewStudy {
  orderId: string;
  encounterId: string;
  patientId: string;
  serviceId: string;
  modality: ImagingModalityValue;
  scheduledAt: string;
}

export async function insertStudy(
  client: pg.ClientBase,
  study: NewStudy,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into imaging_studies
       (tenant_id, order_id, encounter_id, patient_id, service_id, modality, scheduled_at, scheduled_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      study.orderId,
      study.encounterId,
      study.patientId,
      study.serviceId,
      study.modality,
      study.scheduledAt,
      userId,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('study was not created');
  return row.id;
}

export async function scheduleStudy(
  client: pg.ClientBase,
  id: string,
  scheduledAt: string | null,
  userId: string,
): Promise<void> {
  await client.query(
    'update imaging_studies set scheduled_at = $2, scheduled_by = $3 where id = $1',
    [id, scheduledAt, scheduledAt === null ? null : userId],
  );
}

export async function performStudy(client: pg.ClientBase, id: string, userId: string) {
  await client.query(
    'update imaging_studies set performed_at = now(), performed_by = $2 where id = $1',
    [id, userId],
  );
}

export interface WorkItemRow {
  order_id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  patient_dob: string;
  service_id: string;
  item_code: string | null;
  item_name: string;
  modality: ImagingModalityValue;
  priority: 'routine' | 'urgent' | 'stat';
  instructions: string | null;
  placed_at: Date;
  ordered_by_name: string;
  order_status: 'placed' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  stage: ImagingStageValue;
  study_id: string | null;
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
 * The hospital's open imaging orders, each with its study, its stage and its modality (the
 * study's, else the service's as it is now). An order moved in progress before radiology was
 * switched on, with no performed study, counts as performed. To schedule sorts by priority, then
 * the oldest ordered first; scheduled by its slot, the soonest first; performed the longest
 * waiting for its report first. Read through `orders_tenant_imaging_open`.
 */
const WORK_ITEMS = `
  select o.id as order_id, o.tenant_id, o.encounter_id, o.patient_id,
    p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
    p.dob::text as patient_dob, o.service_id, o.item_code, o.item_name,
    coalesce(st.modality, sv.modality, 'other') as modality, o.priority, o.instructions,
    o.placed_at, coalesce(u.name, '') as ordered_by_name, o.status as order_status,
    w.stage, st.id as study_id,
    case when w.stage = 'to_schedule'
      then case o.priority when 'stat' then 0 when 'urgent' then 1 else 2 end
      else 0 end as rank,
    w.sort_at,
    to_char(w.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
  from orders o
  join patients p on p.tenant_id = o.tenant_id and p.id = o.patient_id
  join services sv on sv.tenant_id = o.tenant_id and sv.id = o.service_id
  left join users u on u.id = o.ordered_by
  left join imaging_studies st on st.tenant_id = o.tenant_id and st.order_id = o.id
  cross join lateral (
    select
      case when st.performed_at is not null or o.status = 'in_progress' then 'performed'
        when st.scheduled_at is not null then 'scheduled'
        else 'to_schedule' end as stage,
      case when st.performed_at is not null or o.status = 'in_progress'
          then coalesce(st.performed_at, o.status_changed_at)
        when st.scheduled_at is not null then st.scheduled_at
        else o.placed_at end as sort_at
  ) w
  where o.type = 'imaging' and o.status not in ('cancelled', 'completed')
    and ($1::text is null or o.priority = $1)
    and ($2::text is null or coalesce(st.modality, sv.modality, 'other') = $2)`;

export interface Worklist {
  rows: WorkItemRow[];
  nextCursor: string | null;
  total?: number;
}

/** One page of the worklist at a stage, with `total` on the first page. Null for a bad cursor. */
export async function listWorklist(
  client: pg.ClientBase,
  filters: {
    stage: ImagingStageValue;
    modality?: string;
    priority?: string;
    cursor?: string;
    limit: number;
  },
): Promise<Worklist | null> {
  const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
  if (after === null) return null;
  const { rows } = await client.query<WorkItemRow>(
    `select * from (${WORK_ITEMS}) w
     where w.stage = $3
       and ($4::int is null or (w.rank, w.sort_at, w.order_id) > ($4, $5::timestamptz, $6::uuid))
     order by w.rank, w.sort_at, w.order_id
     limit $7`,
    [
      filters.priority ?? null,
      filters.modality ?? null,
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
  if (after === undefined) {
    const counted = await client.query<{ total: number }>(
      `select count(*)::int as total from (${WORK_ITEMS}) w where w.stage = $3`,
      [filters.priority ?? null, filters.modality ?? null, filters.stage],
    );
    list.total = counted.rows[0]?.total ?? 0;
  }
  return list;
}
