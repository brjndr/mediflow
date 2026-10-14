import fp from 'fastify-plugin';
import type pg from 'pg';
import type { JobQueue, SendOptions } from '../jobs/queue.js';
import type { Notifier } from '../notifier/notifier.js';
import { APP_ROLE } from '../tenancy/plugin.js';
import { withAuthTransaction } from './db.js';
import { newToken } from './sessions.js';

/**
 * Staff email about an invitation or a password reset, sent by a job after the request has
 * committed, so a slow mail server never slows a request and a failed send is retried.
 *
 * The job carries ids only. The link's token is made by the job when it sends: the request saves
 * the invite or the reset with a hash that matches no token, and the job replaces that hash with
 * the hash of a new token, commits, and then sends. So no token or address is ever kept in the
 * queue's own table, which has no row-level security. Each attempt makes a new token, so only the
 * newest link works, as when an invite is sent again. A link that was used, withdrawn or replaced,
 * or that expired before the job ran, is not sent, nor is an invitation to a suspended hospital.
 */

export const INVITE_EMAIL = 'email.invite';
export const PASSWORD_RESET_EMAIL = 'email.password_reset';

export interface InviteEmailJob {
  tenantId: string;
  inviteId: string;
}

export interface PasswordResetEmailJob {
  resetId: string;
}

/**
 * From 30 s, doubling with jitter: the last retry comes 15 to 31 minutes after the first attempt.
 * A reset link lasts 30 minutes, so a late retry of one finds it expired and sends nothing.
 */
const RETRIES: SendOptions = { retryLimit: 5, retryDelay: 30, retryBackoff: true };

/** Queues the invitation email. Call it once the invite is committed (`request.afterCommit`). */
export function queueInviteEmail(jobs: JobQueue, job: InviteEmailJob): Promise<void> {
  // The job id is the invite's, so the same invitation is never queued twice.
  return jobs.send(INVITE_EMAIL, job, { id: job.inviteId, ...RETRIES });
}

/** Queues the reset email. Call it once the reset is committed. */
export function queuePasswordResetEmail(jobs: JobQueue, job: PasswordResetEmailJob): Promise<void> {
  return jobs.send(PASSWORD_RESET_EMAIL, job, { id: job.resetId, ...RETRIES });
}

/** One transaction as the app role at the hospital, as a request of that hospital runs. */
async function atHospital<T>(
  pool: pg.Pool,
  tenantId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch((failure: unknown) => {
      // The connection is in an unknown state: it is destroyed, not given back to the pool.
      broken = failure instanceof Error ? failure : new Error('rollback failed');
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Gives an open invite a new token and emails its link. False when the invite is not open. */
export async function deliverInvite(
  pool: pg.Pool,
  notifier: Notifier,
  job: InviteEmailJob,
): Promise<boolean> {
  const { token, hash } = newToken();
  const invite = await atHospital(pool, job.tenantId, async (client) => {
    const { rows } = await client.query<{ email: string; hospital_name: string; hours: number }>(
      `update invites set token_hash = $2
       where id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
         and exists (select from tenants where id = app_tenant_id() and status = 'active')
       returning email, (select name from tenants where id = app_tenant_id()) as hospital_name,
                 greatest(1, round(extract(epoch from expires_at - now()) / 3600))::int as hours`,
      [job.inviteId, hash],
    );
    return rows[0];
  });
  if (!invite) return false;
  await notifier.send({
    to: invite.email,
    template: 'invite',
    data: {
      hospitalName: invite.hospital_name,
      linkPath: `/invite?token=${token}`,
      expiresInHours: invite.hours,
    },
  });
  return true;
}

/** Gives an open reset link a new token and emails it. False when the link is not open. */
export async function deliverPasswordReset(
  pool: pg.Pool,
  notifier: Notifier,
  job: PasswordResetEmailJob,
): Promise<boolean> {
  const { token, hash } = newToken();
  const reset = await withAuthTransaction(pool, async ({ client }) => {
    const { rows } = await client.query<{ email: string; minutes: number }>(
      `update password_resets r set token_hash = $2
       from users u
       where r.id = $1 and r.used_at is null and r.expires_at > now()
         and u.id = r.user_id and u.status = 'active'
       returning u.email,
                 greatest(1, round(extract(epoch from r.expires_at - now()) / 60))::int as minutes`,
      [job.resetId, hash],
    );
    return rows[0];
  });
  if (!reset) return false;
  await notifier.send({
    to: reset.email,
    template: 'password_reset',
    data: { linkPath: `/reset-password?token=${token}`, expiresInMinutes: reset.minutes },
  });
  return true;
}

/** Registers the workers that send staff email. */
export const staffEmailsPlugin = fp(
  async (app) => {
    const { pool } = app.database;
    const run = async (template: string, jobId: string, send: () => Promise<boolean>) => {
      try {
        await send();
      } catch (error) {
        // The id and the template only: never the address, and never the error, whose text can
        // quote the address (the queue keeps only `safeJobError`). The queue retries the job.
        app.log.warn({ event: 'email_send_failed', template, jobId }, 'email not sent');
        throw error;
      }
    };
    app.jobs.work<InviteEmailJob>(INVITE_EMAIL, (job) =>
      run('invite', job.inviteId, () => deliverInvite(pool, app.notifier, job)),
    );
    app.jobs.work<PasswordResetEmailJob>(PASSWORD_RESET_EMAIL, (job) =>
      run('password_reset', job.resetId, () => deliverPasswordReset(pool, app.notifier, job)),
    );
  },
  { name: 'staff-emails', dependencies: ['db', 'jobs', 'notifier'] },
);
