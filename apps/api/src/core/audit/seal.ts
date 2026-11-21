import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { WORKER_ROLE } from '../outbox/dispatcher.js';

/**
 * Tamper evidence for the audit log (#1081, migration 0153).
 *
 * Every few minutes each hospital's new audit rows are sealed: a seal covers the rows whose
 * transaction id lies in [xidFrom, xidTo), and holds their count, a SHA-256 of their content
 * (worked out by the database, `audit_seal_digest`) and an HMAC-SHA-256 over all of that and the
 * previous seal, keyed with AUDIT_SEAL_KEY, which the database never sees. `xidTo` is the oldest
 * transaction still running, so every transaction below it has ended and the range cannot gain a
 * row honestly. Seals chain per hospital from 0.
 *
 * The verify job works each digest out again and checks the HMAC and the chain. A row changed,
 * removed or slipped into a sealed range, or a seal removed from the middle of a chain, is reported.
 *
 * Limits: it detects, it does not prevent; rows newer than the last seal (minutes) are not yet
 * covered; someone with the whole database could remove the newest seal of a hospital and let the
 * job seal its range again after changing it, which the `audit_sealed` log line (the head of each
 * chain, shipped off the database) is there to expose until seals are copied to write-once storage.
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

/** Runs `work` in a transaction as the worker role, the only role that reaches the seal functions. */
async function asWorker<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface Digest {
  row_count: string;
  min_at: Date | null;
  digest: Buffer;
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
  xidTo: string;
  rowCount: number;
  seal: string;
}

/**
 * Seals every hospital's rows written by transactions that have all ended. Returns the seals
 * written, one per hospital at most. Safe to run twice at once: a second seal for the same start is
 * refused by the table and skipped.
 */
export async function sealAuditLog(pool: pg.Pool, key: Buffer): Promise<SealedHead[]> {
  // Taken before anything else, in a transaction of its own that writes nothing: every
  // transaction with an id below this has committed or rolled back.
  const upto = await asWorker(pool, async (client) => {
    const { rows } = await client.query<{ upto: string }>(
      'select pg_snapshot_xmin(pg_current_snapshot())::text as upto',
    );
    return rows[0]!.upto;
  });
  const due = await asWorker(pool, async (client) => {
    const { rows } = await client.query<{
      tenant_id: string;
      xid_from: string;
      prev_seal: Buffer | null;
    }>('select tenant_id, xid_from::text, prev_seal from audit_seal_due($1::xid8)', [upto]);
    return rows;
  });

  const written: SealedHead[] = [];
  for (const head of due) {
    const sealed = await asWorker(pool, async (client) => {
      const found = await digestOf(client, head.tenant_id, head.xid_from, upto);
      const rowCount = Number(found.row_count);
      if (rowCount === 0 || !found.min_at) return null;
      const seal = sealOf(key, {
        tenantId: head.tenant_id,
        xidFrom: head.xid_from,
        xidTo: upto,
        rowCount,
        minAt: found.min_at,
        digest: found.digest,
        prevSeal: head.prev_seal,
      });
      const { rowCount: inserted } = await client.query(
        `insert into audit_seal
           (tenant_id, xid_from, xid_to, row_count, min_at, digest, prev_seal, seal)
         values ($1, $2::xid8, $3::xid8, $4, $5, $6, $7, $8)
         on conflict (tenant_id, xid_from) do nothing`,
        [
          head.tenant_id,
          head.xid_from,
          upto,
          rowCount,
          found.min_at,
          found.digest,
          head.prev_seal,
          seal,
        ],
      );
      if (!inserted) return null;
      return { tenantId: head.tenant_id, xidTo: upto, rowCount, seal: seal.toString('hex') };
    });
    if (sealed) written.push(sealed);
  }
  return written;
}

export type SealProblem =
  'digest_mismatch' | 'seal_mismatch' | 'chain_gap' | 'chain_link_mismatch' | 'chain_start';

export interface SealMismatch {
  tenantId: string;
  sealId: string;
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
  sealed_at: Date;
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
}

/**
 * Checks the seals: every chain (unbroken from 0, each seal naming the one before it) and, for the
 * seals in scope, the rows again (count, digest) and the HMAC. Returns what does not hold, by
 * hospital and seal id with a code; the content of a row is never part of the answer.
 */
export async function verifyAuditSeals(
  pool: pg.Pool,
  key: Buffer,
  options: VerifyOptions,
): Promise<{ checked: number; mismatches: SealMismatch[] }> {
  const seals = await asWorker(pool, async (client) => {
    const { rows } = await client.query<SealRow>(
      `select id, tenant_id, xid_from::text, xid_to::text, row_count, min_at, digest, prev_seal,
              seal, sealed_at
       from audit_seal order by tenant_id, xid_from`,
    );
    return rows;
  });

  const mismatches: SealMismatch[] = [];
  const toCheck: SealRow[] = [];
  const older: SealRow[] = [];
  let previous: SealRow | undefined;
  for (const row of seals) {
    const first = previous?.tenant_id !== row.tenant_id;
    const report = (problem: SealProblem) =>
      mismatches.push({ tenantId: row.tenant_id, sealId: row.id, problem });
    if (first) {
      if (row.xid_from !== '0' || row.prev_seal !== null) report('chain_start');
    } else if (row.xid_from !== previous!.xid_to) {
      report('chain_gap');
    } else if (!same(row.prev_seal, previous!.seal)) {
      report('chain_link_mismatch');
    }
    previous = row;

    if (options.retainedFrom && row.min_at < options.retainedFrom) continue;
    if (options.scope === 'all' || (options.since && row.sealed_at >= options.since)) {
      toCheck.push(row);
    } else {
      older.push(row);
    }
  }
  for (let left = Math.min(options.sample ?? 0, older.length); left > 0; left--) {
    const pick = Math.floor(Math.random() * older.length);
    toCheck.push(older.splice(pick, 1)[0]!);
  }

  for (const row of toCheck) {
    const found = await asWorker(pool, (client) =>
      digestOf(client, row.tenant_id, row.xid_from, row.xid_to),
    );
    const report = (problem: SealProblem) =>
      mismatches.push({ tenantId: row.tenant_id, sealId: row.id, problem });
    if (Number(found.row_count) !== Number(row.row_count) || !same(found.digest, row.digest)) {
      report('digest_mismatch');
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
    if (!same(expected, row.seal)) report('seal_mismatch');
  }
  return { checked: toCheck.length, mismatches };
}
