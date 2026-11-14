import type pg from 'pg';

/** The three age bands of the `outstanding` report, oldest last. */
export const AGE_BANDS = ['days_0_7', 'days_8_30', 'over_30'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encode = (at: string, id: string): string =>
  Buffer.from(JSON.stringify(['outstanding', at, id])).toString('base64url');

/** `[instant, id]` of a cursor made here, or null for anything else. */
export function decode(cursor: string): [string, string] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [kind, at, id] = value as unknown[];
    if (kind !== 'outstanding' || typeof at !== 'string' || typeof id !== 'string') return null;
    if (!INSTANT.test(at) || Number.isNaN(Date.parse(at)) || !UUID.test(id)) return null;
    return [at, id];
  } catch {
    return null;
  }
}

export interface OutstandingInvoice {
  id: string;
  number: string;
  issuedAt: string;
  ageDays: number;
  totalMinor: number;
  dueMinor: number;
}

/**
 * The invoices behind one age band of `outstanding`, oldest first, a page at a time. The same
 * rule as the report (issued, something due, age in days at the hospital's clock). Invoice
 * numbers and amounts only: no patient is named. `null` when the cursor is not one of ours.
 */
export async function listOutstanding(
  client: pg.ClientBase,
  band: AgeBand,
  options: { cursor?: string; limit: number },
): Promise<{ items: OutstandingInvoice[]; nextCursor: string | null } | null> {
  const after = options.cursor ? decode(options.cursor) : undefined;
  if (after === null) return null;
  const { rows } = await client.query<{
    id: string;
    number: string;
    issued_at: Date;
    at_exact: string;
    age: number;
    total: string;
    due: string;
  }>(
    `with t as (select timezone from tenants where id = app_tenant_id()),
     aged as (
       select i.id, i.number, i.issued_at, i.total_minor,
              to_char(i.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_exact,
              i.total_minor - i.paid_minor - i.credited_minor as due,
              ((now() at time zone t.timezone)::date
                - (i.issued_at at time zone t.timezone)::date) as age
       from invoices i, t
       where i.status = 'issued' and i.total_minor - i.paid_minor - i.credited_minor > 0
     )
     select id, number, issued_at, at_exact, age, total_minor::text as total, due::text as due
     from aged
     where (case when age <= 7 then 'days_0_7' when age <= 30 then 'days_8_30'
                 else 'over_30' end) = $1
       and ($2::timestamptz is null or (issued_at, id) > ($2::timestamptz, $3::uuid))
     order by issued_at, id
     limit $4`,
    [band, after?.[0] ?? null, after?.[1] ?? null, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      number: r.number,
      issuedAt: r.issued_at.toISOString(),
      ageDays: r.age,
      totalMinor: Number(r.total),
      dueMinor: Number(r.due),
    })),
    nextCursor: rows.length > options.limit && last ? encode(last.at_exact, last.id) : null,
  };
}
