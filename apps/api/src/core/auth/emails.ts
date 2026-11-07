import fp from 'fastify-plugin';
import type pg from 'pg';
import type { JobContext, JobQueue, SendOptions } from '../jobs/queue.js';
import type { Notifier } from '../notifier/notifier.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
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
 *
 * The invite row says how it went (#349): `email_queued_at` when it was queued, `email_sent_at`
 * when the mail server took it, `email_failed_at` when the last attempt failed or it could not be
 * queued. Times only: never the address or the error.
 */

export const INVITE_EMAIL = 'email.invite';
export const PASSWORD_RESET_EMAIL = 'email.password_reset';
export const PASSWORD_CHANGED_EMAIL = 'email.password_changed';

export interface InviteEmailJob {
  tenantId: string;
  inviteId: string;
  /** The attempt this job belongs to (`invites.email_attempt`); none for the first. */
  attempt?: string;
}

export interface PasswordResetEmailJob {
  resetId: string;
}

export interface PasswordChangedEmailJob {
  userId: string;
  /** The `account_events` row of the change: the job id, so it is never queued twice. */
  eventId: string;
}

/**
 * From 30 s, doubling with jitter: the last retry comes 15 to 31 minutes after the first attempt.
 * A reset link lasts 30 minutes, so a late retry of one finds it expired and sends nothing.
 */
const RETRIES: SendOptions = { retryLimit: 5, retryDelay: 30, retryBackoff: true };

/**
 * Queues the invitation email. Call it once the invite is committed (`request.afterCommit`).
 * The job id is the invite's, so the same invitation is never queued twice; sending an invite
 * again passes a fresh `jobId`, since the first one is already taken.
 */
export function queueInviteEmail(
  jobs: JobQueue,
  job: InviteEmailJob,
  jobId: string = job.inviteId,
): Promise<void> {
  return jobs.send(INVITE_EMAIL, job, { id: jobId, ...RETRIES });
}

/** Queues the reset email. Call it once the reset is committed. */
export function queuePasswordResetEmail(jobs: JobQueue, job: PasswordResetEmailJob): Promise<void> {
  return jobs.send(PASSWORD_RESET_EMAIL, job, { id: job.resetId, ...RETRIES });
}

/** Queues the notice that the password was changed. Call it once the change is committed. */
export function queuePasswordChangedEmail(
  jobs: JobQueue,
  job: PasswordChangedEmailJob,
): Promise<void> {
  return jobs.send(PASSWORD_CHANGED_EMAIL, job, { id: job.eventId, ...RETRIES });
}

const OPEN_INVITE = 'accepted_at is null and revoked_at is null';
/** Only the invite's current attempt: a job of an earlier one (before a resend) must not write. */
const CURRENT_ATTEMPT = 'email_attempt is not distinct from $2::uuid';

export interface StatusLog {
  warn(fields: object, message: string): void;
}

/** A status write that failed is logged by the invite's id only, and never thrown. */
function statusWriteFailed(log: StatusLog | undefined, job: InviteEmailJob): () => void {
  return () =>
    log?.warn({ event: 'invite_email_status_failed', inviteId: job.inviteId }, 'status not saved');
}

/** Records that the mail server took an open invite's email. Never throws: the email has gone. */
export async function markInviteEmailSent(
  pool: pg.Pool,
  job: InviteEmailJob,
  log?: StatusLog,
): Promise<void> {
  await withTenantTransaction(pool, job.tenantId, (client) =>
    client.query(
      `update invites set email_sent_at = now(), email_failed_at = null
       where id = $1 and ${CURRENT_ATTEMPT} and ${OPEN_INVITE}`,
      [job.inviteId, job.attempt ?? null],
    ),
  ).catch(statusWriteFailed(log, job));
}

/**
 * Records that an open invite's email could not be sent: its last attempt failed, or it could not
 * be queued. A time only. Never throws, so it can sit in a failure path.
 */
export async function markInviteEmailFailed(
  pool: pg.Pool,
  job: InviteEmailJob,
  log?: StatusLog,
): Promise<void> {
  await withTenantTransaction(pool, job.tenantId, (client) =>
    client.query(
      `update invites set email_failed_at = now(), email_sent_at = null
       where id = $1 and ${CURRENT_ATTEMPT} and ${OPEN_INVITE}`,
      [job.inviteId, job.attempt ?? null],
    ),
  ).catch(statusWriteFailed(log, job));
}

/**
 * Queues the invitation email, and marks the invite as not sent when the queue refuses it, so the
 * list can say so. The error is rethrown for the caller to log. Call it after the commit.
 */
export async function queueInviteEmailTracked(
  jobs: JobQueue,
  pool: pg.Pool,
  job: InviteEmailJob,
  jobId?: string,
  log?: StatusLog,
): Promise<void> {
  try {
    await queueInviteEmail(jobs, job, jobId);
  } catch (error) {
    await markInviteEmailFailed(pool, job, log);
    throw error;
  }
}

/** Gives an open invite a new token and emails its link. False when the invite is not open. */
export async function deliverInvite(
  pool: pg.Pool,
  notifier: Notifier,
  job: InviteEmailJob,
): Promise<boolean> {
  const { token, hash } = newToken();
  const invite = await withTenantTransaction(pool, job.tenantId, async (client) => {
    const { rows } = await client.query<{ email: string; hospital_name: string; hours: number }>(
      `update invites set token_hash = $2
       where id = $1 and email_attempt is not distinct from $3::uuid and accepted_at is null and revoked_at is null and expires_at > now()
         and exists (select from tenants where id = app_tenant_id() and status = 'active')
       returning email, (select name from tenants where id = app_tenant_id()) as hospital_name,
                 greatest(1, round(extract(epoch from expires_at - now()) / 3600))::int as hours`,
      [job.inviteId, hash, job.attempt ?? null],
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

/** Tells the account's owner the password changed. False when the account is not active. */
export async function deliverPasswordChanged(
  pool: pg.Pool,
  notifier: Notifier,
  job: PasswordChangedEmailJob,
): Promise<boolean> {
  const email = await withAuthTransaction(pool, async ({ client, identify }) => {
    await identify(job.userId);
    const { rows } = await client.query<{ email: string }>(
      "select email from users where id = $1 and status = 'active'",
      [job.userId],
    );
    return rows[0]?.email;
  });
  if (!email) return false;
  await notifier.send({ to: email, template: 'password_changed', data: {} });
  return true;
}

/** Registers the workers that send staff email. */
export const staffEmailsPlugin = fp(
  async (app) => {
    const { pool } = app.database;
    const run = async (
      template: string,
      jobId: string,
      send: () => Promise<boolean>,
      lastAttempt: boolean,
      onSent?: () => Promise<void>,
      onGaveUp?: () => Promise<void>,
    ) => {
      try {
        if (await send()) await onSent?.();
      } catch (error) {
        if (lastAttempt) await onGaveUp?.();
        // The id and the template only: never the address, and never the error, whose text can
        // quote the address (the queue keeps only `safeJobError`). The queue retries the job.
        app.log.warn({ event: 'email_send_failed', template, jobId }, 'email not sent');
        throw error;
      }
    };
    const final = (context: JobContext) => context.retryCount >= context.retryLimit;
    app.jobs.work<InviteEmailJob>(INVITE_EMAIL, (job, context) =>
      run(
        'invite',
        job.inviteId,
        () => deliverInvite(pool, app.notifier, job),
        final(context),
        () => markInviteEmailSent(pool, job, app.log),
        () => markInviteEmailFailed(pool, job, app.log),
      ),
    );
    app.jobs.work<PasswordResetEmailJob>(PASSWORD_RESET_EMAIL, (job, context) =>
      run(
        'password_reset',
        job.resetId,
        () => deliverPasswordReset(pool, app.notifier, job),
        final(context),
      ),
    );
    app.jobs.work<PasswordChangedEmailJob>(PASSWORD_CHANGED_EMAIL, (job, context) =>
      run(
        'password_changed',
        job.eventId,
        () => deliverPasswordChanged(pool, app.notifier, job),
        final(context),
      ),
    );
  },
  { name: 'staff-emails', dependencies: ['db', 'jobs', 'notifier'] },
);
