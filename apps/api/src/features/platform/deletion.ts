import type pg from 'pg';
import type { FileStore } from '../../core/files/store.js';
import { withPlatformTransaction } from '../../core/platform/db.js';
import { withTenantTransaction } from '../../core/tenancy/transaction.js';
import { recordPlatformAudit } from './repository.js';
import { deletedTables, deletionOrder, EXPORTED_SPECIAL } from './tenant-data.js';

export const DELETE_JOB = 'platform.delete';

/** Ids only: the queue's own table has no row-level security. */
export interface DeleteJob {
  deletionId: string;
}

/** Why a hospital's data may not be deleted yet. The first that applies is reported. */
export type DeletionBlocker =
  | 'hospital_not_offboarding'
  | 'grace_period_not_over'
  | 'export_not_downloaded'
  | 'legal_hold'
  | 'medico_legal_open';

export interface DeletionBasis {
  /** The export that was made and downloaded, or null with a waiver. */
  exportId: string | null;
  waiverReference: string | null;
}

/** A run silent for this long was left by a worker that stopped; the next delivery takes it. */
const STALE_MINUTES = 120;

/**
 * Whether a hospital's data may be deleted now (decided in #959): it is offboarding, its grace
 * period is over, there is a downloaded export or a waiver, and there is no legal hold and no open
 * medico-legal case (a flagged case not yet disposed of). Read again by the job, since time
 * passes between the request and the run. The holds and cases are read as the hospital (the
 * platform role has no grant on them).
 */
export async function deletionBlocker(
  pool: pg.Pool,
  hospitalId: string,
  basis: DeletionBasis,
): Promise<DeletionBlocker | null> {
  const platform = await withPlatformTransaction(pool, async (client) => {
    const hospital = await client.query<{ status: string; due: boolean }>(
      'select status, coalesce(delete_after <= now(), false) as due from tenants where id = $1',
      [hospitalId],
    );
    const row = hospital.rows[0];
    if (row?.status !== 'offboarding') return 'hospital_not_offboarding' as const;
    if (!row.due) return 'grace_period_not_over' as const;
    if (basis.exportId !== null) {
      const made = await client.query(
        `select 1 from tenant_exports
         where id = $1 and hospital_id = $2 and status = 'succeeded'
           and first_downloaded_at is not null`,
        [basis.exportId, hospitalId],
      );
      if (made.rowCount === 0) return 'export_not_downloaded' as const;
    }
    return null;
  });
  if (platform) return platform;
  return withTenantTransaction(
    pool,
    hospitalId,
    async (client) => {
      const hold = await client.query(
        'select 1 from document_legal_holds where released_at is null limit 1',
      );
      if (hold.rowCount) return 'legal_hold' as const;
      const open = await client.query(
        `select 1 from er_medico_legal m
         join er_encounters e on e.tenant_id = m.tenant_id and e.id = m.case_id
         where e.status <> 'disposed' limit 1`,
      );
      return open.rowCount ? ('medico_legal_open' as const) : null;
    },
    { readOnly: true },
  );
}

interface Claimed {
  hospitalId: string;
  requestedBy: string;
  approvedBy: string;
  basis: DeletionBasis;
}

async function claim(pool: pg.Pool, deletionId: string): Promise<Claimed | null> {
  return withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      hospital_id: string;
      requested_by: string;
      approved_by: string;
      export_id: string | null;
      waiver_reference: string | null;
    }>(
      `update tenant_deletions set status = 'running', started_at = now()
       where id = $1
         and (status = 'approved'
              or (status = 'running' and started_at < now() - make_interval(mins => $2)))
       returning hospital_id, requested_by, approved_by, export_id, waiver_reference`,
      [deletionId, STALE_MINUTES],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      hospitalId: row.hospital_id,
      requestedBy: row.requested_by,
      approvedBy: row.approved_by,
      basis: { exportId: row.export_id, waiverReference: row.waiver_reference },
    };
  });
}

class VerificationFailed extends Error {}

const failureCode = (error: unknown): string =>
  error instanceof VerificationFailed ? 'verification_failed' : 'failed';

/** Every stored file the hospital's rows name, and the archives of its own exports. */
async function storedFileKeys(pool: pg.Pool, hospitalId: string): Promise<string[]> {
  const keys = new Set<string>();
  await withTenantTransaction(
    pool,
    hospitalId,
    async (client) => {
      for (const [table, treatment] of Object.entries(EXPORTED_SPECIAL)) {
        if (!treatment.fileKey) continue;
        // The names come from the registry, never from a request.
        const { rows } = await client.query<{ k: string | null }>(
          `select "${treatment.fileKey}" as k from "${table}" where "${treatment.fileKey}" is not null`,
        );
        for (const { k } of rows) if (k) keys.add(k);
      }
    },
    { readOnly: true },
  );
  await withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{ file_key: string }>(
      'select file_key from tenant_exports where hospital_id = $1 and file_key is not null',
      [hospitalId],
    );
    for (const { file_key } of rows) keys.add(file_key);
  });
  return [...keys].sort();
}

/** The rows: every table in foreign-key order, the check, the tombstone. One transaction. */
async function deleteRows(
  pool: pg.Pool,
  hospitalId: string,
  deletionId: string,
  approvedBy: string,
  files: number,
): Promise<{ tables: number; rows: number }> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    // Append-only triggers refuse a delete, and they are right to for every request; this is the
    // one place a hospital's records go. Needs a login that may set this (a superuser, or one
    // granted SET on session_replication_role). The order below does not depend on it.
    await client.query('set local session_replication_role = replica');
    const refs = await client.query<{ child: string; parent: string }>(
      `select c.relname as child, p.relname as parent
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_class p on p.oid = k.confrelid
       where k.contype = 'f' and c.relnamespace = 'public'::regnamespace`,
    );
    let rows = 0;
    const order = deletionOrder(deletedTables(), refs.rows);
    for (const table of order) {
      // The names come from the registry, never from a request.
      const result = await client.query(`delete from "${table}" where tenant_id = $1`, [
        hospitalId,
      ]);
      rows += result.rowCount ?? 0;
    }
    // A person's sessions are not the hospital's records: the ones that named it go on, with none.
    await client.query('update sessions set active_tenant_id = null where active_tenant_id = $1', [
      hospitalId,
    ]);

    // The check: no table that carries tenant_id still holds a row of the hospital, whatever the
    // registry says (a table added since is caught here, not left behind).
    const carriers = await client.query<{ name: string }>(
      `select c.relname as name
       from pg_class c join pg_attribute a on a.attrelid = c.oid
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and not c.relispartition and a.attname = 'tenant_id' and not a.attisdropped`,
    );
    for (const { name } of carriers.rows) {
      const left = await client.query(`select 1 from "${name}" where tenant_id = $1 limit 1`, [
        hospitalId,
      ]);
      if (left.rowCount) throw new VerificationFailed();
    }

    // The tombstone: the row stays, without the hospital's contact details.
    const tombstone = await client.query(
      `update tenants set status = 'deleted', deleted_at = now(), address = null, phone = null,
         registration_number = null, gstin = null, theme_logo_url = null, delete_after = null,
         version = version + 1, updated_at = now()
       where id = $1 and status = 'offboarding'`,
      [hospitalId],
    );
    if (tombstone.rowCount !== 1) throw new VerificationFailed();
    await client.query(
      `update tenant_deletions set status = 'done', finished_at = now(), table_count = $2,
         row_count = $3, file_count = $4
       where id = $1 and status = 'running'`,
      [deletionId, order.length + 1, rows, files],
    );
    await recordPlatformAudit(client, {
      actorId: approvedBy,
      action: 'hospital.deleted',
      entity: 'hospital_deletion',
      entityId: deletionId,
      hospitalId,
      detail: { tables: order.length + 1, rows, files },
    });
    await client.query('commit');
    return { tables: order.length + 1, rows };
  } catch (error) {
    await client.query('rollback').catch((failure: unknown) => {
      broken = failure instanceof Error ? failure : new Error('rollback failed');
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Deletes a hospital's data (#961): its stored files, then every row of every tenant table, in
 * foreign-key order, in one transaction that also leaves the tombstone and checks that nothing is
 * left. Runs only for an approved deletion and checks the rules again (`deletionBlocker`), so a
 * hospital reactivated since is not touched. Every step goes to the platform trail. A run that
 * fails is marked `failed` with a code, rolls the rows back and is not retried by itself: a new
 * request needs a new approval. Safe to deliver twice: the claim lets one delivery work.
 */
export async function runDeletion(
  pool: pg.Pool,
  files: FileStore,
  job: DeleteJob,
): Promise<'deleted' | 'skipped' | 'blocked' | 'failed'> {
  const claimed = await claim(pool, job.deletionId);
  if (!claimed) return 'skipped';
  const { hospitalId, requestedBy, approvedBy, basis } = claimed;
  const audit = (client: pg.ClientBase, action: string, detail: Record<string, number | string>) =>
    recordPlatformAudit(client, {
      actorId: approvedBy,
      action,
      entity: 'hospital_deletion',
      entityId: job.deletionId,
      hospitalId,
      detail,
    });
  const fail = async (code: string, action: string) => {
    await withPlatformTransaction(pool, async (client) => {
      await client.query(
        `update tenant_deletions set status = 'failed', failure = $2, finished_at = now()
         where id = $1 and status = 'running'`,
        [job.deletionId, code],
      );
      await audit(client, action, { reason: code });
    }).catch(() => undefined);
  };

  try {
    const blocker = await deletionBlocker(pool, hospitalId, basis);
    if (blocker) {
      await fail(blocker, 'hospital.deletion_blocked');
      return 'blocked';
    }
    await withPlatformTransaction(pool, (client) =>
      audit(client, 'hospital.deletion_started', { requestedBy }),
    );

    // Files first: removing is repeatable, and the rows that name them are still there to find.
    const keys = await storedFileKeys(pool, hospitalId);
    for (const key of keys) await files.delete(key);
    for (const key of keys) {
      if ((await files.get(key)) !== null) throw new VerificationFailed();
    }
    await withPlatformTransaction(pool, (client) =>
      audit(client, 'hospital.deletion_files_deleted', { files: keys.length }),
    );

    await deleteRows(pool, hospitalId, job.deletionId, approvedBy, keys.length);
    return 'deleted';
  } catch (error) {
    await fail(failureCode(error), 'hospital.deletion_failed');
    return 'failed';
  }
}
