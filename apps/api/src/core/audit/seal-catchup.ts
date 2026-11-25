import type pg from 'pg';
import { withWorkerTransaction } from '../tenancy/transaction.js';
import { copySeals, type MirroredSeal, type SealMirror } from './seal-mirror.js';

/**
 * Copies the seals of the last `days` days that have no copy in the bucket (#1158). A copy that
 * failed when its seal was written (the bucket was down) is made here on a later run, so
 * `audit.seal-verify` does not report `mirror_missing` for a gap nobody had to fix by hand. Seals
 * written in the last `graceMinutes` are left to the run that wrote them. Returns the seals that
 * are still without a copy.
 */
export async function copyMissingSeals(
  pool: pg.Pool,
  mirror: SealMirror,
  options: { days?: number; graceMinutes?: number } = {},
): Promise<MirroredSeal[]> {
  const days = options.days ?? 7;
  const grace = options.graceMinutes ?? 10;
  const stored = await withWorkerTransaction(
    pool,
    async (client) =>
      (
        await client.query<{
          tenant_id: string;
          xid_from: string;
          xid_to: string;
          row_count: string;
          prev_seal: Buffer | null;
          seal: Buffer;
        }>(
          `select tenant_id, xid_from::text, xid_to::text, row_count::text, prev_seal, seal
           from audit_seal
           where sealed_at > now() - make_interval(days => $1)
             and sealed_at < now() - make_interval(mins => $2)
           order by tenant_id, xid_from`,
          [days, grace],
        )
      ).rows,
    { readOnly: true },
  );
  const byTenant = new Map<string, typeof stored>();
  for (const row of stored)
    byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row]);
  const missing: MirroredSeal[] = [];
  for (const [tenantId, rows] of byTenant) {
    const have = new Set(
      (await mirror.list(tenantId)).map((copy) => `${copy.xidFrom}:${copy.seal}`),
    );
    for (const row of rows) {
      const seal = row.seal.toString('hex');
      if (have.has(`${row.xid_from}:${seal}`)) continue;
      missing.push({
        tenantId,
        xidFrom: row.xid_from,
        xidTo: row.xid_to,
        seal,
        prevSeal: row.prev_seal ? row.prev_seal.toString('hex') : null,
        rowCount: Number(row.row_count),
      });
    }
  }
  return copySeals(mirror, missing);
}
