import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { withTenantTransaction } from '../../core/tenancy/transaction.js';
import type { Cell, ReportColumn, ReportKind, ReportResult } from './schemas.js';

/** Rows a report may have: past it the report is refused, never cut short. */
export const SYNC_MAX_ROWS = 5000;
export const RUN_MAX_ROWS = 20_000;

/** Thrown when a report has more rows than it may. */
export class TooLarge extends Error {
  constructor() {
    super('report_too_large');
    this.name = 'TooLarge';
  }
}

/**
 * Runs `work` in a read-only transaction as the app role at the hospital, on the pool given
 * (the read replica when there is one), with a time limit the database enforces. Row-level
 * security applies exactly as in a request.
 */
export async function readAtHospital<T>(
  pool: pg.Pool,
  tenantId: string,
  timeoutMs: number,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(pool, tenantId, work, {
    readOnly: true,
    statementTimeoutMs: timeoutMs,
  });
}

/** A database number as a JS number; a sum that no longer fits is a failure, not a wrong figure. */
function num(value: string | number | null): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new Error('report_number_too_large');
  return parsed;
}

type Query = (client: pg.PoolClient, from: string, to: string, limit: number) => Promise<Cell[][]>;

/** The hospital's day range as two instants on its own clock: `lo` inclusive, `hi` exclusive. */
const DAY_BOUNDS = `
  ($1::date::timestamp at time zone t.timezone) as lo,
  (($2::date + 1)::timestamp at time zone t.timezone) as hi`;

const opdCensus: Query = async (client, from, to, limit) => {
  const { rows } = await client.query<{
    day: string;
    department: string | null;
    opened: number;
    closed: number;
    cancelled: number;
  }>(
    `select (e.opened_at at time zone t.timezone)::date::text as day,
            d.name as department,
            count(*)::int as opened,
            (count(*) filter (where e.status = 'closed'))::int as closed,
            (count(*) filter (where e.status = 'cancelled'))::int as cancelled
     from tenants t
     cross join lateral (select ${DAY_BOUNDS}) b
     join encounters e on e.tenant_id = t.id and e.type = 'opd'
       and e.opened_at >= b.lo and e.opened_at < b.hi
     left join departments d on d.tenant_id = e.tenant_id and d.id = e.department_id
     where t.id = app_tenant_id()
     group by 1, d.name
     order by 1, d.name nulls last
     limit $3`,
    [from, to, limit + 1],
  );
  return rows.map((r) => [r.day, r.department, r.opened, r.closed, r.cancelled]);
};

const opdHourly: Query = async (client, from, to, limit) => {
  const { rows } = await client.query<{ day: string; hour: number; opened: number }>(
    `select (e.opened_at at time zone t.timezone)::date::text as day,
            extract(hour from e.opened_at at time zone t.timezone)::int as hour,
            count(*)::int as opened
     from tenants t
     cross join lateral (select ${DAY_BOUNDS}) b
     join encounters e on e.tenant_id = t.id and e.type = 'opd'
       and e.opened_at >= b.lo and e.opened_at < b.hi
     where t.id = app_tenant_id()
     group by 1, 2
     order by 1, 2
     limit $3`,
    [from, to, limit + 1],
  );
  return rows.map((r) => [r.day, r.hour, r.opened]);
};

const revenue: Query = async (client, from, to, limit) => {
  const { rows } = await client.query<{
    day: string;
    invoiced: string;
    credited: string;
    collected: string;
    refunded: string;
  }>(
    `with t as (select timezone from tenants where id = app_tenant_id()),
     b as (select ${DAY_BOUNDS} from t),
     moved as (
       select (i.issued_at at time zone t.timezone)::date as day,
              i.total_minor as invoiced, 0::bigint as credited, 0::bigint as collected,
              0::bigint as refunded
       from invoices i, b, t
       where i.status in ('issued', 'paid') and i.issued_at >= b.lo and i.issued_at < b.hi
       union all
       select (c.created_at at time zone t.timezone)::date, 0::bigint, c.amount_minor,
              0::bigint, 0::bigint
       from credit_notes c, b, t
       where c.created_at >= b.lo and c.created_at < b.hi
       union all
       select (p.at at time zone t.timezone)::date, 0::bigint, 0::bigint,
              case when p.kind = 'payment' then p.amount_minor else 0::bigint end,
              case when p.kind = 'refund' then p.amount_minor else 0::bigint end
       from payments p, b, t
       where p.at >= b.lo and p.at < b.hi
     )
     select day::text as day, sum(invoiced)::text as invoiced, sum(credited)::text as credited,
            sum(collected)::text as collected, sum(refunded)::text as refunded
     from moved group by day order by day limit $3`,
    [from, to, limit + 1],
  );
  return rows.map((r) => {
    const collected = num(r.collected);
    const refunded = num(r.refunded);
    return [r.day, num(r.invoiced), num(r.credited), collected, refunded, collected - refunded];
  });
};

const collections: Query = async (client, from, to, limit) => {
  const { rows } = await client.query<{
    day: string;
    method: string;
    taken_by: string | null;
    collected: string;
    refunded: string;
  }>(
    `with t as (select timezone from tenants where id = app_tenant_id()),
     b as (select ${DAY_BOUNDS} from t)
     select (p.at at time zone t.timezone)::date::text as day, p.method, u.name as taken_by,
            (coalesce(sum(p.amount_minor) filter (where p.kind = 'payment'), 0))::text as collected,
            (coalesce(sum(p.amount_minor) filter (where p.kind = 'refund'), 0))::text as refunded
     from payments p
     cross join b cross join t
     left join users u on u.id = p.recorded_by
     where p.at >= b.lo and p.at < b.hi
     group by 1, p.method, p.recorded_by, u.name
     order by 1, p.method, u.name nulls last, p.recorded_by
     limit $3`,
    [from, to, limit + 1],
  );
  return rows.map((r) => {
    const collected = num(r.collected);
    const refunded = num(r.refunded);
    return [r.day, r.method, r.taken_by, collected, refunded, collected - refunded];
  });
};

/** Issued invoices not fully paid, by age in days since issue at the hospital's clock. */
const outstanding: Query = async (client) => {
  const { rows } = await client.query<{ bucket: string; invoices: number; due: string }>(
    `with t as (select timezone from tenants where id = app_tenant_id()),
     aged as (
       select i.total_minor - i.paid_minor - i.credited_minor as due,
              ((now() at time zone t.timezone)::date
                - (i.issued_at at time zone t.timezone)::date) as age
       from invoices i, t
       where i.status = 'issued' and i.total_minor - i.paid_minor - i.credited_minor > 0
     ),
     bucketed as (
       select due, case when age <= 7 then 'days_0_7' when age <= 30 then 'days_8_30'
                        else 'over_30' end as bucket
       from aged
     )
     select k.bucket, count(b.due)::int as invoices, coalesce(sum(b.due), 0)::text as due
     from (values ('days_0_7', 1), ('days_8_30', 2), ('over_30', 3)) as k(bucket, ord)
     left join bucketed b on b.bucket = k.bucket
     group by k.bucket, k.ord order by k.ord`,
  );
  return rows.map((r) => [r.bucket, r.invoices, num(r.due)]);
};

const labTurnaround: Query = async (client, from, to, limit) => {
  const { rows } = await client.query<{
    code: string;
    name: string;
    results: number;
    avg: number;
    p90: number;
    max: number;
  }>(
    `select r.test_code as code, r.test_name as name, count(*)::int as results,
            round(avg(m.minutes))::int as avg,
            round(percentile_cont(0.9) within group (order by m.minutes))::int as p90,
            round(max(m.minutes))::int as max
     from tenants t
     cross join lateral (select ${DAY_BOUNDS}) b
     join lab_results r on r.tenant_id = t.id and r.status = 'verified' and r.amends_id is null
       and r.verified_at >= b.lo and r.verified_at < b.hi
     join lab_samples s on s.tenant_id = r.tenant_id and s.id = r.sample_id
     cross join lateral (
       select greatest(0, extract(epoch from (r.verified_at - s.collected_at)) / 60) as minutes
     ) m
     where t.id = app_tenant_id()
     group by r.lab_test_id, r.test_code, r.test_name
     order by r.test_name, r.test_code
     limit $3`,
    [from, to, limit + 1],
  );
  return rows.map((r) => [r.code, r.name, r.results, r.avg, r.p90, r.max]);
};

const stock: Query = async (client, _from, _to, limit) => {
  const { rows } = await client.query<{
    drug: string;
    on_hand: string;
    batches: number;
    nearest: string;
    expired: string;
    value: string;
  }>(
    `with today as (select (now() at time zone timezone)::date as d from tenants
                    where id = app_tenant_id())
     select d.generic_name || coalesce(' ' || d.strength, '') as drug,
            sum(b.on_hand::bigint)::text as on_hand,
            count(distinct b.batch_id)::int as batches,
            min(sb.expiry_date)::text as nearest,
            coalesce(sum(b.on_hand::bigint) filter (where sb.expiry_date < today.d), 0)::text as expired,
            coalesce(sum(b.on_hand::bigint * sb.cost_minor), 0)::text as value
     from stock_balances b
     join stock_batches sb on sb.tenant_id = b.tenant_id and sb.id = b.batch_id
     join drugs d on d.tenant_id = sb.tenant_id and d.id = sb.drug_id
     cross join today
     where b.on_hand > 0
     group by d.id, d.generic_name, d.strength
     order by d.generic_name, d.strength nulls first, d.id
     limit $1`,
    [limit + 1],
  );
  return rows.map((r) => [
    r.drug,
    num(r.on_hand),
    r.batches,
    r.nearest,
    num(r.expired),
    num(r.value),
  ]);
};

const doctorActivity: Query = async (client, from, to, limit) => {
  const { rows } = await client.query<{
    doctor: string;
    department: string | null;
    opened: number;
    closed: number;
    cancelled: number;
    completed: number;
    no_shows: number;
  }>(
    `with b as (select ${DAY_BOUNDS} from tenants t where t.id = app_tenant_id()),
     seen as (
       select e.attending_doctor_id as doctor_id,
              count(*)::int as opened,
              (count(*) filter (where e.status = 'closed'))::int as closed,
              (count(*) filter (where e.status = 'cancelled'))::int as cancelled,
              0 as completed, 0 as no_shows
       from encounters e, b
       where e.tenant_id = app_tenant_id() and e.type = 'opd' and e.attending_doctor_id is not null
         and e.opened_at >= b.lo and e.opened_at < b.hi
       group by e.attending_doctor_id
       union all
       select a.doctor_id, 0, 0, 0,
              (count(*) filter (where a.status = 'completed'))::int,
              (count(*) filter (where a.status = 'no_show'))::int
       from appointments a, b
       where a.tenant_id = app_tenant_id() and a.starts_at >= b.lo and a.starts_at < b.hi
       group by a.doctor_id
     )
     select u.name as doctor, d.name as department,
            sum(s.opened)::int as opened, sum(s.closed)::int as closed,
            sum(s.cancelled)::int as cancelled, sum(s.completed)::int as completed,
            sum(s.no_shows)::int as no_shows
     from seen s
     join doctors dr on dr.tenant_id = app_tenant_id() and dr.id = s.doctor_id
     join users u on u.id = dr.user_id
     left join departments d on d.tenant_id = dr.tenant_id and d.id = dr.department_id
     group by dr.id, u.name, d.name
     order by u.name, dr.id
     limit $3`,
    [from, to, limit + 1],
  );
  return rows.map((r) => [
    r.doctor,
    r.department,
    r.opened,
    r.closed,
    r.cancelled,
    r.completed,
    r.no_shows,
  ]);
};

const pharmacySales: Query = async (client, from, to, limit) => {
  const { rows } = await client.query<{
    day: string;
    sales: number;
    sold: string;
    returned: string;
    dispenses: number;
    units: string;
  }>(
    `with t as (select timezone from tenants where id = app_tenant_id()),
     b as (select ${DAY_BOUNDS} from t),
     moved as (
       select (s.sold_at at time zone t.timezone)::date as day, 1 as sales, s.total_minor as sold,
              0::bigint as returned, 0 as dispenses, 0::bigint as units
       from pharmacy_sales s, b, t
       where s.tenant_id = app_tenant_id() and s.sold_at >= b.lo and s.sold_at < b.hi
       union all
       select (r.returned_at at time zone t.timezone)::date, 0, 0::bigint, r.total_minor, 0, 0::bigint
       from pharmacy_sale_returns r, b, t
       where r.tenant_id = app_tenant_id() and r.returned_at >= b.lo and r.returned_at < b.hi
       union all
       select (x.dispensed_at at time zone t.timezone)::date, 0, 0::bigint, 0::bigint, 1,
              x.quantity::bigint
       from dispenses x, b, t
       where x.tenant_id = app_tenant_id() and x.dispensed_at >= b.lo and x.dispensed_at < b.hi
       union all
       select (r.returned_at at time zone t.timezone)::date, 0, 0::bigint, 0::bigint, 0,
              -l.quantity::bigint
       from dispense_returns r
       join dispense_return_lines l on l.tenant_id = r.tenant_id and l.return_id = r.id, b, t
       where r.tenant_id = app_tenant_id() and r.returned_at >= b.lo and r.returned_at < b.hi
     )
     select day::text as day, sum(sales)::int as sales, sum(sold)::text as sold,
            sum(returned)::text as returned, sum(dispenses)::int as dispenses,
            sum(units)::text as units
     from moved group by day order by day limit $3`,
    [from, to, limit + 1],
  );
  return rows.map((r) => {
    const sold = num(r.sold);
    const returned = num(r.returned);
    return [r.day, r.sales, sold, returned, sold - returned, r.dispenses, num(r.units)];
  });
};

const col = (key: string, type: ReportColumn['type']): ReportColumn => ({ key, type });

const DEFINITIONS: Record<
  ReportKind,
  { columns: ReportColumn[]; sums: string[]; query: Query; snapshot?: true }
> = {
  opd_census: {
    columns: [
      col('day', 'date'),
      col('department', 'text'),
      col('opened', 'integer'),
      col('closed', 'integer'),
      col('cancelled', 'integer'),
    ],
    sums: ['opened', 'closed', 'cancelled'],
    query: opdCensus,
  },
  opd_hourly: {
    columns: [col('day', 'date'), col('hour', 'integer'), col('opened', 'integer')],
    sums: ['opened'],
    query: opdHourly,
  },
  revenue: {
    columns: [
      col('day', 'date'),
      col('invoicedMinor', 'money'),
      col('creditedMinor', 'money'),
      col('collectedMinor', 'money'),
      col('refundedMinor', 'money'),
      col('netCollectedMinor', 'money'),
    ],
    sums: [
      'invoicedMinor',
      'creditedMinor',
      'collectedMinor',
      'refundedMinor',
      'netCollectedMinor',
    ],
    query: revenue,
  },
  lab_turnaround: {
    columns: [
      col('testCode', 'text'),
      col('testName', 'text'),
      col('results', 'integer'),
      col('avgMinutes', 'minutes'),
      col('p90Minutes', 'minutes'),
      col('maxMinutes', 'minutes'),
    ],
    sums: ['results'],
    query: labTurnaround,
  },
  doctor_activity: {
    columns: [
      col('doctor', 'text'),
      col('department', 'text'),
      col('opened', 'integer'),
      col('closed', 'integer'),
      col('cancelled', 'integer'),
      col('appointmentsCompleted', 'integer'),
      col('noShows', 'integer'),
    ],
    sums: ['opened', 'closed', 'cancelled', 'appointmentsCompleted', 'noShows'],
    query: doctorActivity,
  },
  pharmacy_sales: {
    columns: [
      col('day', 'date'),
      col('sales', 'integer'),
      col('soldMinor', 'money'),
      col('returnedMinor', 'money'),
      col('netSoldMinor', 'money'),
      col('dispenses', 'integer'),
      col('unitsDispensed', 'integer'),
    ],
    sums: ['sales', 'soldMinor', 'returnedMinor', 'netSoldMinor', 'dispenses', 'unitsDispensed'],
    query: pharmacySales,
  },
  collections: {
    columns: [
      col('day', 'date'),
      col('method', 'text'),
      col('takenBy', 'text'),
      col('collectedMinor', 'money'),
      col('refundedMinor', 'money'),
      col('netCollectedMinor', 'money'),
    ],
    sums: ['collectedMinor', 'refundedMinor', 'netCollectedMinor'],
    query: collections,
  },
  outstanding: {
    columns: [col('ageBucket', 'text'), col('invoices', 'integer'), col('dueMinor', 'money')],
    sums: ['invoices', 'dueMinor'],
    query: outstanding,
    snapshot: true,
  },
  stock: {
    columns: [
      col('drug', 'text'),
      col('onHand', 'integer'),
      col('batches', 'integer'),
      col('nearestExpiry', 'date'),
      col('expiredOnHand', 'integer'),
      col('valueMinor', 'money'),
    ],
    sums: ['onHand', 'expiredOnHand', 'valueMinor'],
    query: stock,
    snapshot: true,
  },
};

/** A snapshot of now (stock) takes no days. */
export const isSnapshot = (kind: ReportKind): boolean => DEFINITIONS[kind].snapshot === true;

/**
 * Works out a report inside a read-only hospital transaction (`readAtHospital`). Throws
 * `TooLarge` past `maxRows`.
 */
export async function computeReport(
  client: pg.PoolClient,
  kind: ReportKind,
  range: { from: string | null; to: string | null },
  maxRows: number,
): Promise<ReportResult> {
  const definition = DEFINITIONS[kind];
  const rows = await definition.query(client, range.from ?? '', range.to ?? '', maxRows);
  if (rows.length > maxRows) throw new TooLarge();
  const { rows: meta } = await client.query<{ currency: string }>(
    'select currency from tenants where id = app_tenant_id()',
  );
  const currency = meta[0]?.currency;
  if (!currency) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');

  const totals: Cell[] = definition.columns.map((column, index) => {
    if (!definition.sums.includes(column.key)) return null;
    return rows.reduce((sum, row) => sum + num(row[index] as number), 0);
  });
  return {
    kind,
    from: range.from,
    to: range.to,
    currency,
    generatedAt: new Date().toISOString(),
    columns: definition.columns,
    rows,
    totals,
  };
}
