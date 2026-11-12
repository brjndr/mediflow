import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { FileStore } from '../../core/files/store.js';
import { asWorker } from '../../core/files/worker.js';
import { withTenantTransaction } from '../../core/tenancy/transaction.js';
import { computeReport, readAtHospital, RUN_MAX_ROWS, TooLarge } from './compute.js';
import { toCsv } from './csv.js';
import type { ReportKind } from './schemas.js';

export const RUN_JOB = 'reports.run';
export const SWEEP_JOB = 'reports.sweep';

export interface RunJob {
  tenantId: string;
  runId: string;
}

/**
 * A run still marked running after this long is taken over by the next delivery of its job: the
 * longest a report may take, and five minutes more, so a slow one is never taken from a live worker.
 */
export const staleMinutesFor = (timeoutMs: number): number => Math.ceil(timeoutMs / 60_000) + 5;

/** The key of a run's file: one folder a hospital, one file a run. */
export const fileKeyOf = (tenantId: string, runId: string): string =>
  `reports/${tenantId}/${runId}.csv`;

interface Claimed {
  kind: ReportKind;
  from: string | null;
  to: string | null;
}

/**
 * Takes the run for this delivery: it is waiting, or running but silent for too long (its worker
 * stopped). A second delivery of a run that has finished finds nothing to take.
 */
function claim(pool: pg.Pool, job: RunJob, staleMinutes: number): Promise<Claimed | null> {
  return withTenantTransaction(pool, job.tenantId, async (client) => {
    const { rows } = await client.query<{
      kind: ReportKind;
      from: string | null;
      to: string | null;
    }>(
      `update report_runs
       set status = 'running', started_at = now()
       where id = $1
         and (status = 'queued'
              or (status = 'running' and started_at < now() - make_interval(mins => $2)))
       returning kind, range_from::text as from, range_to::text as to`,
      [job.runId, staleMinutes],
    );
    return rows[0] ?? null;
  });
}

/** The code a failure is kept as: never the database's own text, which can quote data. */
function failureCode(error: unknown): string {
  if (error instanceof TooLarge) return 'too_large';
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  // 57014: the statement ran past its time limit.
  return code === '57014' ? 'timeout' : 'failed';
}

/**
 * Makes one stored report: reads it on the replica under a time limit, keeps its CSV in the file
 * store and its table with the run. A report that cannot be made ends the run as `failed` with a
 * code, and is not retried: the person asks again. Handlers are idempotent: the claim lets one
 * delivery work, and the file's key is the run's, so writing it twice changes nothing.
 */
export async function runReport(
  pools: { pool: pg.Pool; reportPool: pg.Pool },
  files: FileStore,
  timeoutMs: number,
  job: RunJob,
): Promise<void> {
  // A run silent for longer than a report may take is one whose worker stopped.
  const claimed = await claim(pools.pool, job, staleMinutesFor(timeoutMs));
  if (!claimed) return;

  const key = fileKeyOf(job.tenantId, job.runId);
  try {
    const result = await readAtHospital(pools.reportPool, job.tenantId, timeoutMs, (client) =>
      computeReport(client, claimed.kind, { from: claimed.from, to: claimed.to }, RUN_MAX_ROWS),
    );
    const csv = toCsv(result);
    await files.put(key, csv);
    const saved = await withTenantTransaction(pools.pool, job.tenantId, (client) =>
      client.query(
        `update report_runs
         set status = 'succeeded', finished_at = now(), row_count = $2, result = $3::jsonb,
             file_key = $4, file_bytes = $5
         where id = $1 and status = 'running'`,
        [job.runId, result.rows.length, JSON.stringify(result), key, csv.length],
      ),
    );
    // The sweep gave the run up while it was being made: nothing names the file, so remove it.
    if (saved.rowCount === 0) await files.delete(key).catch(() => undefined);
  } catch (error) {
    // The file may have been written before the failure; a failed run names none.
    await files.delete(key).catch(() => undefined);
    await withTenantTransaction(pools.pool, job.tenantId, (client) =>
      client.query(
        `update report_runs set status = 'failed', failure = $2, finished_at = now()
         where id = $1 and status = 'running'`,
        [job.runId, failureCode(error)],
      ),
    );
  }
}

/**
 * Hourly, at every hospital, as the worker role: gives up the runs that have been waiting or
 * running for an hour (`stalled`, so the hospital's quota is not held for ever) and deletes the
 * runs past their retention with their files.
 */
export async function sweepReports(
  app: Pick<FastifyInstance, 'database'>,
  files: FileStore,
): Promise<string[]> {
  const expired = await asWorker(app, async (client) => {
    await client.query(
      `update report_runs set status = 'failed', failure = 'stalled', finished_at = now()
       where status in ('queued', 'running') and requested_at < now() - interval '1 hour'`,
    );
    const { rows } = await client.query<{ id: string; tenant_id: string }>(
      'select id, tenant_id from report_runs where expires_at < now() order by expires_at limit 500',
    );
    return rows;
  });

  // Files first, then rows: a file that cannot be deleted keeps its run, and the next sweep tries
  // again, so no file outlives its retention. The key is the run's own whether or not the run
  // got as far as naming it (a run that failed after its file was written names none).
  const failed: string[] = [];
  const gone: string[] = [];
  for (const run of expired) {
    const key = fileKeyOf(run.tenant_id, run.id);
    try {
      await files.delete(key);
      gone.push(run.id);
    } catch {
      failed.push(key);
    }
  }
  if (gone.length > 0) {
    await asWorker(app, (client) =>
      client.query('delete from report_runs where id = any($1::uuid[]) and expires_at < now()', [
        gone,
      ]),
    );
  }
  return failed;
}
