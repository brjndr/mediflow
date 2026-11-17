import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { JobQueue } from '../../core/jobs/queue.js';
import type { FileStore } from '../../core/files/store.js';
import { withPlatformTransaction } from '../../core/platform/db.js';
import { withTenantTransaction } from '../../core/tenancy/transaction.js';
import { recordPlatformAudit } from './repository.js';
import { deletedTables, deletionOrder, EXPORTED_SPECIAL } from './tenant-data.js';

export const DELETE_JOB = 'platform.delete';

/** The role the rows are deleted as. Created in migrations/0145. */
export const DELETION_ROLE = 'mediflow_deletion';

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
  const platform = await withPlatformTransaction(pool, (client) =>
    platformBlocker(client, hospitalId, basis),
  );
  if (platform) return platform;
  return withTenantTransaction(pool, hospitalId, (client) => holdBlocker(client, hospitalId), {
    readOnly: true,
  });
}

async function platformBlocker(
  client: pg.ClientBase,
  hospitalId: string,
  basis: DeletionBasis,
): Promise<DeletionBlocker | null> {
  const hospital = await client.query<{ status: string; due: boolean }>(
    'select status, coalesce(delete_after <= now(), false) as due from tenants where id = $1',
    [hospitalId],
  );
  const row = hospital.rows[0];
  if (row?.status !== 'offboarding') return 'hospital_not_offboarding';
  if (!row.due) return 'grace_period_not_over';
  if (basis.exportId !== null) {
    const made = await client.query(
      `select 1 from tenant_exports
       where id = $1 and hospital_id = $2 and status = 'succeeded'
         and first_downloaded_at is not null`,
      [basis.exportId, hospitalId],
    );
    if (made.rowCount === 0) return 'export_not_downloaded';
  }
  return null;
}

/** Holds and cases of one hospital. `hospitalId` is explicit so it also holds on a connection with no tenant. */
async function holdBlocker(
  client: pg.ClientBase,
  hospitalId: string,
): Promise<DeletionBlocker | null> {
  const hold = await client.query(
    'select 1 from document_legal_holds where tenant_id = $1 and released_at is null limit 1',
    [hospitalId],
  );
  if (hold.rowCount) return 'legal_hold';
  const open = await client.query(
    `select 1 from er_medico_legal m
     join er_encounters e on e.tenant_id = m.tenant_id and e.id = m.case_id
     where m.tenant_id = $1 and e.status <> 'disposed' limit 1`,
    [hospitalId],
  );
  return open.rowCount ? 'medico_legal_open' : null;
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

/** A rule that stopped the deletion between the job's first check and the transaction. */
class StoppedBy extends Error {
  constructor(readonly blocker: DeletionBlocker) {
    super(blocker);
  }
}

const failureCode = (error: unknown): string =>
  error instanceof VerificationFailed
    ? 'verification_failed'
    : error instanceof StoppedBy
      ? error.blocker
      : 'failed';

/** What the job logs: a fixed event name, ids and a code, never an error's own text. */
export interface DeletionLog {
  error(fields: Record<string, string>, message: string): void;
}

/**
 * Every stored file the hospital's rows name, and the archives of its own exports. Read on the
 * deletion's own connection, with the hospital named in each query.
 */
async function storedFileKeys(client: pg.ClientBase, hospitalId: string): Promise<string[]> {
  const keys = new Set<string>();
  for (const [table, treatment] of Object.entries(EXPORTED_SPECIAL)) {
    if (!treatment.fileKey) continue;
    // The names come from the registry, never from a request.
    const { rows } = await client.query<{ k: string | null }>(
      `select "${treatment.fileKey}" as k from "${table}"
       where tenant_id = $1 and "${treatment.fileKey}" is not null`,
      [hospitalId],
    );
    for (const { k } of rows) if (k) keys.add(k);
  }
  const archives = await client.query<{ file_key: string }>(
    'select file_key from tenant_exports where hospital_id = $1 and file_key is not null',
    [hospitalId],
  );
  for (const { file_key } of archives.rows) keys.add(file_key);
  return [...keys].sort();
}

/**
 * Every key the stores build is `<kind>/<hospital id>/...`. A key of another hospital's folder
 * (a row written wrongly, or tampered with) must never be deleted by this hospital's job.
 */
export function assertOwnKeys(keys: readonly string[], hospitalId: string): void {
  for (const key of keys) {
    if (key.split('/')[1] !== hospitalId) throw new VerificationFailed();
  }
}

/**
 * The rows: every table in foreign-key order, the check, the tombstone. One transaction, which
 * also stores the keys of the files to remove afterwards. Returns those keys.
 */
export async function deleteHospitalRows(
  pool: pg.Pool,
  hospitalId: string,
  deletionId: string,
  approvedBy: string,
): Promise<string[]> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    // The job's own role (#999): the privileges below and nothing the API's login holds. It
    // bypasses row-level security, so the explicit tenant_id in every statement is the guard.
    await client.query(`set local role ${DELETION_ROLE}`);
    // The same row locks as reactivate, suspend and offboard take (the hospital first, then the
    // deletion), so none of them changes the hospital while this runs.
    await client.query("select set_config('app.tenant_id', $1, true)", [hospitalId]);
    await client.query('select 1 from tenants where id = $1 for update', [hospitalId]);
    const run = await client.query<{ export_id: string | null; waiver_reference: string | null }>(
      `select export_id, waiver_reference from tenant_deletions
       where id = $1 and hospital_id = $2 and status = 'running' for update`,
      [deletionId, hospitalId],
    );
    const basis = run.rows[0];
    if (!basis) throw new VerificationFailed();
    // The rules again, now that nothing can change them: the first reading was a while ago.
    const blocker =
      (await platformBlocker(client, hospitalId, {
        exportId: basis.export_id,
        waiverReference: basis.waiver_reference,
      })) ?? (await holdBlocker(client, hospitalId));
    if (blocker) throw new StoppedBy(blocker);

    const keys = await storedFileKeys(client, hospitalId);
    assertOwnKeys(keys, hospitalId);

    // Append-only triggers refuse a delete, and they are right to for every request; this is the
    // one place a hospital's records go. Needs a role that may set this (a superuser, or
    // `mediflow_deletion` granted SET on session_replication_role by migration 0145). The order below does not depend on it.
    await client.query('set local session_replication_role = replica');
    const refs = await client.query<{ child: string; parent: string }>(
      `select c.relname as child, p.relname as parent
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_class p on p.oid = k.confrelid
       where k.contype = 'f' and c.relnamespace = 'public'::regnamespace`,
    );
    const registry = new Set(deletedTables());
    // Replica mode turns off foreign keys and cascades, so a table outside the registry that
    // points into it would keep orphans unseen. None may exist: refuse before touching a row.
    if (unregisteredChildren(refs.rows, registry).length > 0) throw new VerificationFailed();

    // Who belonged here, read before the memberships go: only these accounts may be removed below.
    const members = await client.query<{ user_id: string }>(
      'select distinct user_id from memberships where tenant_id = $1',
      [hospitalId],
    );
    const memberIds = members.rows.map((m) => m.user_id);

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

    // The records of the deletion itself go through the triggers like any other write.
    await client.query('set local session_replication_role = origin');
    // Accounts (#997, DPDP): a person of this hospital with no membership anywhere now has no
    // reason to be kept. Someone who also belongs to another hospital stays, and so does a
    // platform admin (who has no membership by design) and any account that never belonged here.
    // With the triggers and cascades back on, their sessions, authenticator and reset tokens go too.
    const accounts = await client.query(
      `delete from users u
       where u.id = any($1::uuid[]) and not u.is_platform_admin
         and not exists (select 1 from memberships m where m.user_id = u.id)`,
      [memberIds],
    );
    const accountCount = accounts.rowCount ?? 0;
    // The tombstone: the row stays, without the hospital's contact details.
    const tombstone = await client.query(
      `update tenants set status = 'deleted', deleted_at = now(), address = null, phone = null,
         registration_number = null, gstin = null, theme_logo_url = null, delete_after = null,
         version = version + 1, updated_at = now()
       where id = $1 and status = 'offboarding'`,
      [hospitalId],
    );
    if (tombstone.rowCount !== 1) throw new VerificationFailed();
    const done = await client.query(
      `update tenant_deletions set status = 'done', finished_at = now(), table_count = $2,
         row_count = $3, file_count = $4, file_keys = $5
       where id = $1 and status = 'running'`,
      [deletionId, order.length + 1, rows, keys.length, keys.length > 0 ? keys : null],
    );
    if (done.rowCount !== 1) throw new VerificationFailed();
    await recordPlatformAudit(client, {
      actorId: approvedBy,
      action: 'hospital.deleted',
      entity: 'hospital_deletion',
      entityId: deletionId,
      hospitalId,
      detail: { tables: order.length + 1, rows, files: keys.length, accounts: accountCount },
    });
    await client.query('commit');
    return keys;
  } catch (error) {
    await client.query('rollback').catch((failure: unknown) => {
      broken = failure instanceof Error ? failure : new Error('rollback failed');
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Foreign keys from a table outside the registry to one inside it (it would keep orphans). */
export function unregisteredChildren(
  references: readonly { child: string; parent: string }[],
  registry: ReadonlySet<string>,
): { child: string; parent: string }[] {
  return references.filter((r) => registry.has(r.parent) && !registry.has(r.child));
}

/**
 * Removes the files of a hospital whose rows are already gone, then records it. Removing is
 * repeatable, so a run that stopped half way is finished by the next call (`sweepDeletions`).
 */
async function deleteFiles(
  pool: pg.Pool,
  files: FileStore,
  deletionId: string,
  hospitalId: string,
  approvedBy: string,
  keys: readonly string[],
): Promise<void> {
  assertOwnKeys(keys, hospitalId);
  for (const key of keys) await files.delete(key);
  for (const key of keys) {
    if ((await files.get(key)) !== null) throw new VerificationFailed();
  }
  await withPlatformTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `update tenant_deletions set files_deleted_at = now(), file_keys = null
       where id = $1 and status = 'done' and files_deleted_at is null`,
      [deletionId],
    );
    if (!rowCount) return;
    await recordPlatformAudit(client, {
      actorId: approvedBy,
      action: 'hospital.deletion_files_deleted',
      entity: 'hospital_deletion',
      entityId: deletionId,
      hospitalId,
      detail: { files: keys.length },
    });
  });
}

/**
 * Deletes a hospital's data (#961): every row of every tenant table, in foreign-key order, in one
 * transaction that also leaves the tombstone and checks that nothing is left; and only after that
 * has committed, its stored files (#995). Files go last because a failed transaction rolls the
 * rows back but cannot bring a file back. Runs only for an approved deletion and checks the rules
 * again, inside the transaction, so a hospital reactivated since is not touched. Every step goes
 * to the platform trail. A run that fails is marked `failed` with a code, rolls the rows back and
 * is not retried by itself: a new request needs a new approval. Safe to deliver twice: an
 * advisory lock held for the whole run and the claim let one delivery work.
 */
export async function runDeletion(
  pool: pg.Pool,
  files: FileStore,
  job: DeleteJob,
  log?: DeletionLog,
  rowsPool: pg.Pool = pool,
): Promise<'deleted' | 'skipped' | 'blocked' | 'failed'> {
  // The lock lives as long as this connection's session, so a run that dies frees it by itself
  // and a live one can never be taken over, however long it takes.
  const lock = await pool.connect();
  let lockBroken: Error | undefined;
  try {
    const got = await lock.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as ok',
      [job.deletionId],
    );
    if (!got.rows[0]?.ok) return 'skipped';
    try {
      return await run(pool, files, job, log, rowsPool);
    } finally {
      await lock
        .query('select pg_advisory_unlock(hashtextextended($1, 0))', [job.deletionId])
        .catch((failure: unknown) => {
          lockBroken = failure instanceof Error ? failure : new Error('unlock failed');
        });
    }
  } finally {
    lock.release(lockBroken);
  }
}

async function run(
  pool: pg.Pool,
  files: FileStore,
  job: DeleteJob,
  log?: DeletionLog,
  rowsPool: pg.Pool = pool,
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
  /** Marks the run failed. The trail only says so when this run is the one that failed it. */
  const fail = (code: string, action: string) =>
    withPlatformTransaction(pool, async (client) => {
      const { rowCount } = await client.query(
        `update tenant_deletions set status = 'failed', failure = $2, finished_at = now()
         where id = $1 and status = 'running'`,
        [job.deletionId, code],
      );
      if (rowCount) await audit(client, action, { reason: code });
    });

  let keys: string[];
  try {
    const blocker = await deletionBlocker(pool, hospitalId, basis);
    if (blocker) {
      await fail(blocker, 'hospital.deletion_blocked');
      return 'blocked';
    }
    await withPlatformTransaction(pool, (client) =>
      audit(client, 'hospital.deletion_started', { requestedBy }),
    );
    keys = await deleteHospitalRows(rowsPool, hospitalId, job.deletionId, approvedBy);
  } catch (error) {
    const code = failureCode(error);
    log?.error(
      { event: 'hospital_deletion_failed', deletionId: job.deletionId, hospitalId, code },
      'hospital deletion failed',
    );
    // A failure to record the failure is not swallowed: the job fails and the queue sees it.
    await fail(
      code,
      code === 'verification_failed' || code === 'failed'
        ? 'hospital.deletion_failed'
        : 'hospital.deletion_blocked',
    );
    return code === 'verification_failed' || code === 'failed' ? 'failed' : 'blocked';
  }

  // The rows are gone for good. A failure now leaves the keys on the deletion's row, and the
  // sweep finishes the removal.
  try {
    await deleteFiles(pool, files, job.deletionId, hospitalId, approvedBy, keys);
  } catch {
    await fileFailed(pool, job.deletionId, hospitalId, approvedBy, log);
  }
  return 'deleted';
}

/**
 * Failed attempts at removing a deleted hospital's files before the sweep gives up (#1001). The
 * first is the run's own, the rest are the sweep's, 15 minutes apart: about five hours.
 */
export const MAX_FILE_ATTEMPTS = 20;

/**
 * Counts a failed removal. At the cap the sweep stops taking the row up and the platform trail
 * gets `hospital.deletion_files_stuck`, so an operator notices; clearing `files_stuck_at` and
 * `file_attempts` on the row lets the sweep try again. Every attempt still logs its line.
 */
async function fileFailed(
  pool: pg.Pool,
  deletionId: string,
  hospitalId: string,
  approvedBy: string,
  log?: DeletionLog,
): Promise<void> {
  log?.error(
    { event: 'hospital_deletion_files_pending', deletionId, hospitalId, code: 'files_pending' },
    'hospital deletion files pending',
  );
  await withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{ file_attempts: number }>(
      `update tenant_deletions set file_attempts = file_attempts + 1,
         files_stuck_at = case when file_attempts + 1 >= $2 then now() else files_stuck_at end
       where id = $1 and status = 'done' and files_deleted_at is null and files_stuck_at is null
       returning file_attempts`,
      [deletionId, MAX_FILE_ATTEMPTS],
    );
    const attempts = rows[0]?.file_attempts;
    if (attempts === undefined || attempts < MAX_FILE_ATTEMPTS) return;
    await recordPlatformAudit(client, {
      actorId: approvedBy,
      action: 'hospital.deletion_files_stuck',
      entity: 'hospital_deletion',
      entityId: deletionId,
      hospitalId,
      detail: { attempts },
    });
  });
}

export const DELETE_SWEEP_JOB = 'platform.delete-sweep';

/** An approved request whose job was not delivered (or whose run stopped) is sent again after this. */
const RESEND_AFTER_MINUTES = 15;

/**
 * Finishes what a delivery left undone (#995): files of a hospital whose rows are already deleted,
 * and an approved request whose job never ran (the queue was down when it was approved) or whose
 * run went silent. Returns how many it took up, so a caller can report it.
 */
export async function sweepDeletions(
  pool: pg.Pool,
  files: FileStore,
  jobs: JobQueue,
  log?: DeletionLog,
): Promise<{ resent: number; filesFinished: number }> {
  const pending = await withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      hospital_id: string;
      approved_by: string;
      file_keys: string[];
    }>(
      `select id, hospital_id, approved_by, file_keys from tenant_deletions
       where status = 'done' and files_deleted_at is null and file_keys is not null
         and files_stuck_at is null
         and finished_at < now() - interval '5 minutes'`,
    );
    return rows;
  });
  let filesFinished = 0;
  for (const row of pending) {
    try {
      await deleteFiles(pool, files, row.id, row.hospital_id, row.approved_by, row.file_keys);
      filesFinished += 1;
    } catch {
      await fileFailed(pool, row.id, row.hospital_id, row.approved_by, log);
    }
  }
  const due = await withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `select id from tenant_deletions
       where (status = 'approved' and approved_at < now() - make_interval(mins => $1))
          or (status = 'running' and started_at < now() - make_interval(mins => $2))`,
      [RESEND_AFTER_MINUTES, STALE_MINUTES],
    );
    return rows;
  });
  for (const { id } of due) {
    const job: DeleteJob = { deletionId: id };
    await jobs.send(DELETE_JOB, job, {
      id: `${DELETE_JOB}:${id}:${randomUUID()}`,
      retryLimit: 3,
      retryDelay: 60,
    });
  }
  return { resent: due.length, filesFinished };
}
