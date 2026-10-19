import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';
import type { QueuePriorityValue, QueueTokenStatusValue } from './schemas.js';

/**
 * The queue SQL. Every statement runs on the request's own transaction under the app role, so
 * row-level security limits it to the active hospital. "Today" is the calendar day at the
 * hospital, worked out in SQL from its timezone; the caller never gives a day.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TokenRow {
  id: string;
  tenant_id: string;
  number: number;
  day: string;
  department_id: string;
  department_name: string;
  doctor_id: string | null;
  doctor_name: string | null;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  status: QueueTokenStatusValue;
  priority: QueuePriorityValue | null;
  issued_at: Date;
  called_at: Date | null;
  call_count: number;
  version: number;
  /** The time the row is ordered by, as Postgres writes it, to the microsecond. */
  order_at: string;
}

const TODAY = `(select (now() at time zone timezone)::date from tenants where id = app_tenant_id())`;

const TOKENS = `select t.id, t.tenant_id, t.number, t.day::text as day,
                       t.department_id, dp.name as department_name,
                       t.doctor_id, u.name as doctor_name,
                       t.patient_id, p.first_name || ' ' || p.last_name as patient_name,
                       p.mrn as patient_mrn,
                       t.status, t.priority, t.issued_at, t.called_at, t.call_count, t.version,
                       (case when t.status in ('called', 'served') then t.called_at
                             else t.issued_at end)::text as order_at
                from queue_tokens t
                join departments dp on dp.id = t.department_id
                join patients p on p.id = t.patient_id
                left join doctors d on d.id = t.doctor_id
                left join users u on u.id = d.user_id`;

/** Who may be seen or changed: the scope the caller holds the permission with, and who they are. */
export interface Visibility {
  scope: PermissionScope;
  userId: string;
}

// `department`: the tokens of the department of the caller's active doctor profile. `own`: the
// caller's own queue, the tokens given to their profile and those of its department given to
// nobody. Someone with no profile sees nothing under either.
const visible = (scope: string, user: string) =>
  `(${scope}::text = 'all'
    or exists (select 1 from doctors o
               where o.user_id::text = ${user}::text and o.active
                 and ((${scope}::text = 'department' and t.department_id = o.department_id)
                      or (${scope}::text = 'own' and (t.doctor_id = o.id
                          or (t.doctor_id is null and t.department_id = o.department_id))))))`;

/** The departments a caller's scope reaches, or null for all of them. */
export async function departmentsInScope(
  client: pg.ClientBase,
  visibility: Visibility,
): Promise<Set<string> | null> {
  if (visibility.scope === 'all') return null;
  const { rows } = await client.query<{ department_id: string }>(
    'select department_id from doctors where user_id::text = $1 and active',
    [visibility.userId],
  );
  return new Set(rows.map((row) => row.department_id));
}

// Call order. The tokens being served (and served) are in the order they were called; the others
// a priority first, then the time issued, the number breaking a tie.
const ORDER_KEY = `case when t.status in ('called', 'served') then 0 else (t.priority is null)::int end,
                   case when t.status in ('called', 'served') then t.called_at else t.issued_at end,
                   t.number, t.id`;

interface Cursor {
  p: number;
  a: string;
  n: number;
  i: string;
}

// A timestamp as Postgres writes one, so a cursor keeps its microseconds.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

const encodeCursor = (row: TokenRow): string => {
  const called = row.status === 'called' || row.status === 'served';
  const cursor: Cursor = {
    p: called ? 0 : Number(row.priority === null),
    a: row.order_at,
    n: row.number,
    i: row.id,
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
};

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { p, a, n, i } = value as Record<string, unknown>;
    if ((p !== 0 && p !== 1) || typeof n !== 'number' || !Number.isInteger(n)) return null;
    if (typeof a !== 'string' || !PG_TIMESTAMP.test(a)) return null;
    if (typeof i !== 'string' || !UUID.test(i)) return null;
    return { p, a, n, i };
  } catch {
    return null;
  }
}

export interface ListFilters {
  status: QueueTokenStatusValue;
  departmentId?: string;
  doctorId?: string;
  cursor?: string;
  limit: number;
}

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/** Today's tokens of one status, in call order. Null for a bad cursor. */
export async function listTokens(
  client: pg.ClientBase,
  filters: ListFilters,
  visibility: Visibility,
): Promise<Page<TokenRow> | null> {
  const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
  if (after === null) return null;
  // An id that is not one matches nothing, as another hospital's does.
  if (
    (filters.departmentId !== undefined && !UUID.test(filters.departmentId)) ||
    (filters.doctorId !== undefined && !UUID.test(filters.doctorId))
  ) {
    return { rows: [], nextCursor: null, ...(after === undefined ? { total: 0 } : {}) };
  }
  const source = `${TOKENS}
    where t.day = ${TODAY}
      and t.status = $1
      and ($2::uuid is null or t.department_id = $2)
      -- A doctor's queue: given to them, or to nobody in their department.
      and ($3::uuid is null or t.doctor_id = $3
           or (t.doctor_id is null and t.department_id = (select department_id from doctors where id = $3)))
      and ${visible('$4', '$5')}`;
  const values = [
    filters.status,
    filters.departmentId ?? null,
    filters.doctorId ?? null,
    visibility.scope,
    visibility.userId,
  ];
  const { rows } = await client.query<TokenRow>(
    `${source}
       and ($6::int is null or (${ORDER_KEY}) > ($6::int, $7::timestamptz, $8::int, $9::uuid))
     order by ${ORDER_KEY}
     limit $10`,
    [
      ...values,
      after?.p ?? null,
      after?.a ?? null,
      after?.n ?? null,
      after?.i ?? null,
      filters.limit + 1,
    ],
  );
  const page = rows.slice(0, filters.limit);
  const last = page.at(-1);
  const result: Page<TokenRow> = {
    rows: page,
    nextCursor: rows.length > filters.limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from (${source}) s`,
      values,
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** One token the caller may see, or null. `forUpdate` locks it for a change. */
export async function findToken(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<TokenRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<TokenRow>(
    `${TOKENS} where t.id = $1 and ${visible('$2', '$3')}${forUpdate ? ' for update of t' : ''}`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

export async function patientExists(client: pg.ClientBase, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await client.query('select 1 from patients where id = $1', [id]);
  return rowCount === 1;
}

export async function departmentOpen(client: pg.ClientBase, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await client.query(
    'select 1 from departments where id = $1 and not archived',
    [id],
  );
  return rowCount === 1;
}

export interface Doctor {
  id: string;
  department_id: string;
}

/**
 * A doctor who practises here now (the profile and the membership active), or null. With a
 * visibility, only one whose queue it reaches: the doctor's own profile under `own`, a doctor of
 * the caller's department under `department`.
 */
export async function practisingDoctor(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility = { scope: 'all', userId: '' },
): Promise<Doctor | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<Doctor>(
    `select d.id, d.department_id
     from doctors d join memberships m on m.user_id = d.user_id
     where d.id = $1 and d.active and m.status = 'active'
       and ($2::text = 'all'
            or exists (select 1 from doctors o where o.user_id::text = $3::text and o.active
                       and (($2::text = 'own' and o.id = d.id)
                            or ($2::text = 'department' and o.department_id = d.department_id))))`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

/**
 * Issues today's next number of the department. The counter row is locked until the transaction
 * ends, so a second desk issuing at the same moment waits and gets the next number; a token that
 * is refused rolls its number back with it.
 */
export async function issueToken(
  client: pg.ClientBase,
  input: {
    patientId: string;
    departmentId: string;
    doctorId: string | null;
    priority: QueuePriorityValue | null;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `with today as (select ${TODAY} as day),
     counter as (
       insert into queue_counters (tenant_id, department_id, day, last_number)
       select app_tenant_id(), $2, day, 1 from today
       on conflict (tenant_id, department_id, day)
         do update set last_number = queue_counters.last_number + 1
       returning day, last_number
     )
     insert into queue_tokens (tenant_id, day, department_id, number, doctor_id, patient_id, priority, issued_by)
     select app_tenant_id(), day, $2, last_number, $3, $1, $4, $5 from counter
     returning id`,
    [input.patientId, input.departmentId, input.doctorId, input.priority, userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('token was not issued');
  return id;
}

/**
 * Calls the next token of a doctor's queue: the first waiting one given to the doctor or to
 * nobody of their department, in call order, and gives it to the doctor; the one the doctor was
 * serving becomes served. Calls for one doctor wait for each other (a lock for the doctor and the
 * transaction); calls for two doctors of a department never take the same token (the candidate is
 * locked, and one already locked is passed over). Null when nobody is waiting, changing nothing.
 */
export async function callNext(
  client: pg.ClientBase,
  doctor: Doctor,
): Promise<{ called: string; served: string | null } | null> {
  await client.query("select pg_advisory_xact_lock(hashtext('queue_call:' || $1::text))", [
    doctor.id,
  ]);
  const next = await client.query<{ id: string }>(
    `select t.id from queue_tokens t
     where t.day = ${TODAY} and t.status = 'waiting'
       and (t.doctor_id = $1 or (t.doctor_id is null and t.department_id = $2))
     order by (t.priority is null), t.issued_at, t.number
     limit 1
     for update skip locked`,
    [doctor.id, doctor.department_id],
  );
  const called = next.rows[0]?.id;
  if (!called) return null;
  const served = await client.query<{ id: string }>(
    `update queue_tokens set status = 'served'
     where doctor_id = $1 and status = 'called' and day = ${TODAY}
     returning id`,
    [doctor.id],
  );
  await client.query(
    `update queue_tokens
     set status = 'called', doctor_id = $2, called_at = now(), call_count = call_count + 1
     where id = $1`,
    [called, doctor.id],
  );
  return { called, served: served.rows[0]?.id ?? null };
}

export async function callAgain(client: pg.ClientBase, id: string): Promise<void> {
  await client.query(
    'update queue_tokens set called_at = now(), call_count = call_count + 1 where id = $1',
    [id],
  );
}

export async function setStatus(
  client: pg.ClientBase,
  id: string,
  status: 'skipped' | 'waiting',
): Promise<void> {
  await client.query('update queue_tokens set status = $2 where id = $1', [id, status]);
}

export async function setPriority(
  client: pg.ClientBase,
  id: string,
  priority: QueuePriorityValue | null,
): Promise<void> {
  await client.query('update queue_tokens set priority = $2 where id = $1', [id, priority]);
}
