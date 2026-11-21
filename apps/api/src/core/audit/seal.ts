import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { withWorkerTransaction } from '../tenancy/transaction.js';

/**
 * Tamper evidence for the audit log (#1081, migrations 0153 and 0154).
 *
 * Every few minutes each hospital's new audit rows are sealed: a seal covers the rows whose
 * transaction id lies in [xidFrom, xidTo), and holds their count, a SHA-256 chain over their
 * content (worked out by the database, `audit_seal_digest`, one row at a time) and an HMAC-SHA-256
 * over all of that and the previous seal, keyed with AUDIT_SEAL_KEY, which the database never sees.
 * `xidTo` is at most the oldest transaction still running, so every transaction below it has ended
 * and the range cannot gain a row honestly; a trigger gives every row its own transaction id. A
 * backlog (a hospital's first seal) is sealed in parts of at most `maxRows` rows. Seals chain per
 * hospital from 0.
 *
 * The verify job checks, in the database, that each chain is unbroken, and works the rows of the
 * seals in scope out again to check the digest and the HMAC. A row changed, removed or slipped into
 * a sealed range, a seal removed from inside a chain, and sealing that has stopped are reported.
 *
 * Limits: it detects, it does not prevent; rows newer than the last seal (minutes) are not yet
 * covered; someone with the whole database could remove any tail of a hospital's chain (or all of
 * it), change rows in that range and let the job seal them again with its key. The `audit_sealed`
 * log line, with each seal and the one before it, kept off the database, is what exposes that until
 * seals are also copied to write-once storage.
 */

export interface SealInput {
  tenantId: string;
  xidFrom: string;
  xidTo: string;
  rowCount: number;
  minAt: Date;
  digest: Buffer;
  prevSeal: Buffer | null;
}

/** The HMAC of a seal. Version 1 of the layout; a change of layout is a new version. */
export function sealOf(key: Buffer, input: SealInput): Buffer {
  const layout = [
    'audit-seal-v1',
    input.tenantId,
    input.xidFrom,
    input.xidTo,
    String(input.rowCount),
    input.minAt.toISOString(),
    input.digest.toString('hex'),
    input.prevSeal?.toString('hex') ?? '',
  ].join('\n');
  return createHmac('sha256', key).update(layout).digest();
}

interface Digest {
  row_count: string;
  min_at: Date | null;
  digest: Buffer | null;
}

async function digestOf(
  client: pg.ClientBase,
  tenantId: string,
  xidFrom: string,
  xidTo: string,
): Promise<Digest> {
  const { rows } = await client.query<Digest>(
    'select row_count, min_at, digest from audit_seal_digest($1, $2::xid8, $3::xid8)',
    [tenantId, xidFrom, xidTo],
  );
  return rows[0]!;
}

export interface SealedHead {
  tenantId: string;
  xidFrom: string;
  xidTo: string;
  rowCount: number;
  seal: string;
  prevSeal: string | null;
}

/** Rows in one seal at most, so a backlog is sealed in parts of bounded work. */
export const SEAL_MAX_ROWS = 50_000;

/**
 * Seals every hospital's rows written by transactions that have all ended. Returns the seals
 * written. Safe to run twice at once: a second seal for the same start is refused by the table
 * and that hospital is left to the other run.
 */
export async function sealAuditLog(
  pool: pg.Pool,
  key: Buffer,
  options: { maxRows?: number } = {},
): Promise<SealedHead[]> {
  const maxRows = options.maxRows ?? SEAL_MAX_ROWS;
  // Taken first, in a transaction of its own that writes nothing: every transaction with an id
  // below this has committed or rolled back.
  const upto = await withWorkerTransaction(pool, async (client) => {
    const { rows } = await client.query<{ upto: string }>(
      'select pg_snapshot_xmin(pg_current_snapshot())::text as upto',
    );
    return rows[0]!.upto;
  });
  const due = await withWorkerTransaction(
    pool,
    async (client) =>
      (
        await client.query<{ tenant_id: string; xid_from: string; prev_seal: Buffer | null }>(
          'select tenant_id, xid_from::text as xid_from, prev_seal from audit_seal_due($1::xid8)',
          [upto],
        )
      ).rows,
  );

  const written: SealedHead[] = [];
  for (const hospital of due) {
    let from = hospital.xid_from;
    let prev = hospital.prev_seal;
    // Each part in a transaction of its own, until the hospital reaches `upto`.
    for (;;) {
      const sealed = await withWorkerTransaction(pool, async (client) => {
        const { rows } = await client.query<{ xid_to: string }>(
          'select audit_seal_end($1, $2::xid8, $3::xid8, $4)::text as xid_to',
          [hospital.tenant_id, from, upto, maxRows],
        );
        const to = rows[0]!.xid_to;
        const found = await digestOf(client, hospital.tenant_id, from, to);
        const rowCount = Number(found.row_count);
        if (rowCount === 0 || !found.min_at || !found.digest) return null;
        const seal = sealOf(key, {
          tenantId: hospital.tenant_id,
          xidFrom: from,
          xidTo: to,
          rowCount,
          minAt: found.min_at,
          digest: found.digest,
          prevSeal: prev,
        });
        const { rowCount: inserted } = await client.query(
          `insert into audit_seal
             (tenant_id, xid_from, xid_to, row_count, min_at, digest, prev_seal, seal)
           values ($1, $2::xid8, $3::xid8, $4, $5, $6, $7, $8)
           on conflict (tenant_id, xid_from) do nothing`,
          [hospital.tenant_id, from, to, rowCount, found.min_at, found.digest, prev, seal],
        );
        if (!inserted) return null;
        return { to, seal, rowCount };
      });
      if (!sealed) break;
      written.push({
        tenantId: hospital.tenant_id,
        xidFrom: from,
        xidTo: sealed.to,
        rowCount: sealed.rowCount,
        seal: sealed.seal.toString('hex'),
        prevSeal: prev?.toString('hex') ?? null,
      });
      if (sealed.to === upto) break;
      from = sealed.to;
      prev = sealed.seal;
    }
  }
  return written;
}

export type SealProblem =
  | 'digest_mismatch'
  | 'seal_mismatch'
  | 'chain_gap'
  | 'chain_link_mismatch'
  | 'chain_start'
  | 'unsealed';

export interface SealMismatch {
  tenantId: string;
  /** The seal that does not hold; null for `unsealed`, which is about rows no seal covers. */
  sealId: string | null;
  problem: SealProblem;
}

interface SealRow {
  id: string;
  tenant_id: string;
  xid_from: string;
  xid_to: string;
  row_count: string;
  min_at: Date;
  digest: Buffer;
  prev_seal: Buffer | null;
  seal: Buffer;
  chain_problem: SealProblem | null;
}

const same = (a: Buffer | null, b: Buffer | null): boolean =>
  a === null || b === null ? a === b : a.length === b.length && timingSafeEqual(a, b);

export interface VerifyOptions {
  /** `all` checks every seal; `recent` those sealed since `since`, plus `sample` older ones. */
  scope: 'all' | 'recent';
  since?: Date;
  sample?: number;
  /** Seals with rows before this (retired months) are no longer checked against their rows. */
  retainedFrom?: Date;
  /** Rows older than this and under no seal mean sealing has stopped. Default one hour. */
  unsealedAfterMinutes?: number;
}

// Each seal with what is wrong with its place in the chain, worked out in the database against
// the seal it says it follows (by index), so no chain is read into memory.
const SEAL_COLUMNS = `
  s.id, s.tenant_id, s.xid_from::text as xid_from, s.xid_to::text as xid_to, s.row_count,
  s.min_at, s.digest, s.prev_seal, s.seal,
  case
    when s.xid_from = '0'::xid8 then
      case when s.prev_seal is null then null else 'chain_start' end
    when p.id is null then 'chain_gap'
    when p.seal is distinct from s.prev_seal then 'chain_link_mismatch'
  end as chain_problem`;
const PREVIOUS = `
  left join lateral (
    select p.id, p.seal from audit_seal p
    where p.tenant_id = s.tenant_id and p.xid_to = s.xid_from
    limit 1
  ) p on true`;

const PAGE = 500;

/**
 * Checks the seals in scope: their place in the chain, then their rows again (count, digest) and
 * the HMAC; and that no hospital has rows that sealing has left behind. Pages through the seals
 * and keeps one page in memory. Returns what does not hold, by hospital and seal id with a code;
 * the content of a row is never part of the answer.
 */
export async function verifyAuditSeals(
  pool: pg.Pool,
  key: Buffer,
  options: VerifyOptions,
): Promise<{ checked: number; mismatches: SealMismatch[] }> {
  const mismatches: SealMismatch[] = [];
  let checked = 0;

  const check = async (rows: SealRow[]) => {
    const report = (row: SealRow, problem: SealProblem) =>
      mismatches.push({ tenantId: row.tenant_id, sealId: row.id, problem });
    const inScope = rows.filter((row) => {
      if (row.chain_problem) report(row, row.chain_problem);
      return !(options.retainedFrom && row.min_at < options.retainedFrom);
    });
    if (inScope.length === 0) return;
    await withWorkerTransaction(
      pool,
      async (client) => {
        for (const row of inScope) {
          checked++;
          const found = await digestOf(client, row.tenant_id, row.xid_from, row.xid_to);
          if (
            Number(found.row_count) !== Number(row.row_count) ||
            !same(found.digest, row.digest)
          ) {
            report(row, 'digest_mismatch');
            continue;
          }
          const expected = sealOf(key, {
            tenantId: row.tenant_id,
            xidFrom: row.xid_from,
            xidTo: row.xid_to,
            rowCount: Number(row.row_count),
            minAt: row.min_at,
            digest: row.digest,
            prevSeal: row.prev_seal,
          });
          if (!same(expected, row.seal)) report(row, 'seal_mismatch');
        }
      },
      { readOnly: true },
    );
  };

  // The seals in scope, a page at a time in (hospital, start) order.
  const all = options.scope === 'all';
  const since = options.since ?? new Date(0);
  let after: { tenant: string; xid: string } | null = null;
  for (;;) {
    const page: SealRow[] = await withWorkerTransaction(
      pool,
      async (client) =>
        (
          await client.query<SealRow>(
            `select ${SEAL_COLUMNS} from audit_seal s ${PREVIOUS}
             where ($1 or s.sealed_at >= $2)
               and ($3::uuid is null or (s.tenant_id, s.xid_from) > ($3::uuid, $4::xid8))
             order by s.tenant_id, s.xid_from
             limit $5`,
            [all, since, after?.tenant ?? null, after?.xid ?? '0', PAGE],
          )
        ).rows,
      { readOnly: true },
    );
    await check(page);
    if (page.length < PAGE) break;
    const last = page[page.length - 1]!;
    after = { tenant: last.tenant_id, xid: last.xid_from };
  }

  // A sample of the older seals, read from a few pages of the table rather than the whole of it.
  const sample = all ? 0 : (options.sample ?? 0);
  if (sample > 0) {
    const sampled = await withWorkerTransaction(
      pool,
      async (client) => {
        const { rows: size } = await client.query<{ n: number }>(
          "select greatest(reltuples, 1)::float8 as n from pg_class where oid = 'audit_seal'::regclass",
        );
        const percent = Math.min(100, Math.max(0.01, ((sample * 10) / size[0]!.n) * 100));
        return (
          await client.query<SealRow>(
            `select ${SEAL_COLUMNS} from audit_seal s tablesample system (${percent.toFixed(4)})
             ${PREVIOUS}
             where s.sealed_at < $1
             limit $2`,
            [since, sample],
          )
        ).rows;
      },
      { readOnly: true },
    );
    await check(sampled);
  }

  // Sealing that has stopped leaves rows behind; without this, no seals would look like no harm.
  const lagging = await withWorkerTransaction(
    pool,
    async (client) =>
      (
        await client.query<{ tenant_id: string }>(
          'select tenant_id from audit_seal_lagging(make_interval(mins => $1))',
          [options.unsealedAfterMinutes ?? 60],
        )
      ).rows,
    { readOnly: true },
  );
  for (const { tenant_id } of lagging) {
    mismatches.push({ tenantId: tenant_id, sealId: null, problem: 'unsealed' });
  }
  return { checked, mismatches };
}
