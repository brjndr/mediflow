import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { APP_ROLE } from '../../core/tenancy/plugin.js';
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
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin read only');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("select set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch((failure: unknown) => {
      broken = failure instanceof Error ? failure : new Error('rollback failed');
    });
    throw error;
  } finally {
    client.release(broken);
  }
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
