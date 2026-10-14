import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { WORKER_ROLE } from '../../core/outbox/dispatcher.js';
import { CHECK_JOB, COMMIT_JOB, runCheck, runCommit, type BatchJob } from './jobs.js';
import { IMPORT_PERMISSIONS } from './permissions.js';
import { importRoutes } from './routes.js';

export const EXPIRE_JOB = 'imports.expire';

/**
 * Gives up, at every hospital, the batches left staged or checked for a week (`expired`) and those
 * whose job stopped without ending (`stalled`: waiting, checking or writing with no sign of life
 * for an hour), and deletes their rows. What was sent of a file of patients is not kept waiting,
 * and a stalled batch no longer stops the hospital from writing the next one. Runs as the worker
 * role, which may do only this to batches.
 */
export async function expireBatches(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    await client.query(
      `with given_up as (
         update import_batches
         set status = case when status in ('staging', 'checked') then 'cancelled' else 'failed' end,
             failure = case when status in ('staging', 'checked') then 'expired' else 'stalled' end,
             finished_at = now(), heartbeat_at = null, claim_token = null
         where (status in ('staging', 'checked') and created_at < now() - interval '7 days')
            or (status in ('checking', 'queued', 'running')
                and coalesce(heartbeat_at, created_at) < now() - interval '1 hour')
         returning tenant_id, id
       )
       delete from import_rows r using given_up g
       where r.tenant_id = g.tenant_id and r.batch_id = g.id`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The import centre: records of a kind another feature registers (`app.importKinds`) loaded from
 * a file. The browser reads the file and maps its columns; rows are staged here, checked by a job
 * and written by another in one transaction. Behind the `imports` module flag.
 */
export const importsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('imports', IMPORT_PERMISSIONS);
  await app.register(importRoutes);

  app.jobs.work<BatchJob>(CHECK_JOB, (job) => runCheck(app.database.pool, app.importKinds, job));
  app.jobs.work<BatchJob>(COMMIT_JOB, (job) => runCommit(app.database.pool, app.importKinds, job));
  app.jobs.work(EXPIRE_JOB, () => expireBatches(app.database.pool));
  // Hourly, so a stalled batch holds up its hospital's imports for an hour at most.
  app.jobs.schedule(EXPIRE_JOB, '30 * * * *');
};
