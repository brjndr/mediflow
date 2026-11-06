import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type pg from 'pg';
import { HttpError } from '../http/errors.js';
import { errors, ref } from '../http/schemas.js';
import { withAuthTransaction } from './db.js';
import { queuePasswordChangedEmail } from './emails.js';
import { recordFailure } from './login.js';
import { checkSecondFactor, isMfaEnabled } from './mfa.js';
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  passwordProblem,
  verifyPassword,
  type PasswordProblem,
} from './password.js';
import { revokeOtherSessions, revokeSession, rotateSessionToken } from './sessions.js';

/**
 * What a signed-in person does to their own account: change the password, see their sessions and
 * end the others. Everything is scoped to the session's user, never to a client value. The routes
 * are session routes, so they stay within reach while an authenticator is still to be set up.
 */

export const AccountSession = Type.Object(
  {
    id: Type.String({
      description:
        'An opaque id for the session, only for ending it. Not the cookie and not derived from it.',
    }),
    createdAt: Type.String({ format: 'date-time' }),
    lastSeenAt: Type.String({ format: 'date-time' }),
    userAgent: Type.Unsafe<string | null>({
      type: ['string', 'null'],
      description:
        'The browser as it described itself at sign-in, cleaned and cut, for the person to recognise the device.',
    }),
    current: Type.Boolean({ description: 'True for the session making this call.' }),
  },
  { $id: 'AccountSession' },
);

export const AccountSessionList = Type.Object(
  {
    items: Type.Array(ref(AccountSession)),
    nextCursor: Type.Null({ description: 'Always null: a person has few sessions.' }),
  },
  { $id: 'AccountSessionList' },
);

export const ACCOUNT_SESSION_SCHEMAS = [AccountSession, AccountSessionList] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTED = 50;
/** Wrong current passwords or codes, and changes, a user may try in a minute. */
const CHANGES_PER_MINUTE = 5;

const PASSWORD_PROBLEMS: Record<PasswordProblem | 'unchanged', [code: string, message: string]> = {
  too_short: ['password_too_short', 'The password needs at least 12 characters'],
  too_long: ['password_too_long', 'The password is too long'],
  too_common: ['password_too_common', 'The password is too easy to guess'],
  unchanged: ['password_unchanged', 'The new password is the same as the current one'],
};

/** One answer for a session that does not exist, belongs to someone else, or has already ended. */
const NO_SUCH_SESSION = () => new HttpError(404, 'not_found', 'No such session');

type Change = { ok: true; eventId: string; token: string } | { ok: false; failure: HttpError };

export const accountSessionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const { pool } = app.database;

  async function record(
    client: pg.PoolClient,
    requestId: string,
    userId: string,
    action: string,
    entity: string,
    entityId: string,
  ) {
    const { rows } = await client.query<{ id: string }>(
      `insert into account_events (user_id, action, entity, entity_id, request_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [userId, action, entity, entityId, requestId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('account event was not written');
    return id;
  }

  app.post(
    '/auth/password/change',
    {
      config: { access: 'session' },
      schema: {
        operationId: 'changePassword',
        tags: ['auth'],
        description:
          "Changes the signed-in user's password. Needs the current password, and a code from the authenticator when the user has one (`code`: 400 mfa_code_required without it). A wrong current password or code counts toward the account lockout, as at sign-in (403 invalid_password; 429 account_locked while locked). Every other session of the user and every outstanding reset link ends; the calling session stays and gets a new token in the cookie. The user is told by email.",
        body: Type.Object({
          currentPassword: Type.String({ minLength: 1, maxLength: 1024 }),
          newPassword: Type.String({ minLength: 1, maxLength: 1024 }),
          code: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 32,
              description: 'Authenticator code or a recovery code. Required with an authenticator.',
            }),
          ),
        }),
        response: {
          204: Type.Null({ description: 'The password was changed' }),
          ...errors(400, 401, 403, 429),
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      const userId = session?.userId;
      const sessionId = session?.id;
      if (!userId || !sessionId) throw new HttpError(401, 'unauthenticated', 'No session');
      const { currentPassword, newPassword, code } = request.body;

      // Before any hashing, so guessing is limited whatever the passwords are.
      const allowed = await app.rateLimiter.hit(`pwchange:${userId}`, CHANGES_PER_MINUTE, 60_000);
      if (!allowed.allowed) {
        throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again shortly.', {
          'retry-after': String(allowed.retryAfterSeconds),
        });
      }

      // Committed whether or not it worked, because a wrong password or code has to be counted.
      // The refusal is thrown afterwards.
      const result = await withAuthTransaction(
        pool,
        async ({ client, identify }): Promise<Change> => {
          await identify(userId);
          const found = await client.query<{
            email: string;
            secret_hash: string | null;
            retry_after: number | null;
          }>(
            `select u.email, i.secret_hash,
                  case when u.locked_until > now()
                       then ceil(extract(epoch from u.locked_until - now()))::int end as retry_after
           from users u
           left join user_identities i on i.user_id = u.id and i.provider = 'password'
           where u.id = $1 and u.status = 'active'
           for update of u`,
            [userId],
          );
          const user = found.rows[0];
          if (!user)
            return { ok: false, failure: new HttpError(401, 'unauthenticated', 'No session') };
          if (user.retry_after !== null) {
            return {
              ok: false,
              failure: new HttpError(429, 'account_locked', 'The account is temporarily locked', {
                'retry-after': String(user.retry_after),
              }),
            };
          }

          const matches =
            user.secret_hash !== null &&
            currentPassword.length <= MAX_PASSWORD_LENGTH &&
            (await verifyPassword(user.secret_hash, currentPassword));
          if (!matches) {
            await recordFailure(client, config, userId);
            // Not a 401: the session is fine, and the web app treats 401 as signed out.
            return {
              ok: false,
              failure: new HttpError(403, 'invalid_password', 'The password is not correct'),
            };
          }

          const problem = passwordProblem(newPassword, { email: user.email });
          if (problem)
            return { ok: false, failure: new HttpError(400, ...PASSWORD_PROBLEMS[problem]) };
          if (newPassword === currentPassword) {
            return { ok: false, failure: new HttpError(400, ...PASSWORD_PROBLEMS.unchanged) };
          }

          // With an authenticator, a stolen session and a guessed password are not enough.
          if (await isMfaEnabled(client, userId)) {
            if (!code) {
              return {
                ok: false,
                failure: new HttpError(
                  400,
                  'mfa_code_required',
                  'Enter the code from your authenticator app',
                ),
              };
            }
            if (!(await checkSecondFactor(client, config, userId, code))) {
              await recordFailure(client, config, userId);
              return {
                ok: false,
                failure: new HttpError(400, 'invalid_mfa_code', 'That code is not valid'),
              };
            }
          }

          const updated = await client.query(
            `update user_identities set secret_hash = $2, updated_at = now()
           where user_id = $1 and provider = 'password'`,
            [userId, await hashPassword(newPassword)],
          );
          if (updated.rowCount !== 1) {
            return {
              ok: false,
              failure: new HttpError(403, 'invalid_password', 'The password is not correct'),
            };
          }
          await revokeOtherSessions(client, userId, sessionId, 'password_changed');
          await client.query(
            'update password_resets set used_at = now() where user_id = $1 and used_at is null',
            [userId],
          );
          await client.query(
            'update users set failed_login_count = 0, locked_until = null, updated_at = now() where id = $1',
            [userId],
          );
          const token = await rotateSessionToken(client, sessionId);
          const eventId = await record(
            client,
            request.id,
            userId,
            'change_password',
            'user',
            userId,
          );
          return { ok: true, eventId, token };
        },
      );

      if (!result.ok) throw result.failure;
      app.auth.setSessionCookie(reply, result.token);
      // The change is made; a queue that is down must not turn it into an error.
      await queuePasswordChangedEmail(app.jobs, { userId, eventId: result.eventId }).catch(() => {
        request.log.warn({ event: 'password_changed_email_not_queued' }, 'email not queued');
      });
      void reply.header('cache-control', 'no-store');
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/auth/sessions',
    {
      config: { access: 'session' },
      schema: {
        operationId: 'listAccountSessions',
        tags: ['auth'],
        description:
          "The signed-in user's own active sessions, newest first, with `current` set on the one making the call. A user has few, so there is one page of at most 50.",
        response: { 200: ref(AccountSessionList), ...errors(401) },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (!session?.id) throw new HttpError(401, 'unauthenticated', 'No session');
      const { userId, id: currentId } = session;
      const items = await withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(userId);
        // Never the token columns: only what the person is shown.
        const { rows } = await client.query<{
          id: string;
          created_at: Date;
          last_seen_at: Date;
          user_agent: string | null;
        }>(
          `select id, created_at, last_seen_at, user_agent from sessions
           where user_id = $1 and revoked_at is null and now() < expires_at
             and now() - last_seen_at <= make_interval(mins => $2)
           order by created_at desc, id desc
           limit ${MAX_LISTED}`,
          [userId, config.SESSION_IDLE_MINUTES],
        );
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          userAgent: row.user_agent,
          current: row.id === currentId,
        }));
      });
      void reply.header('cache-control', 'no-store');
      return { items, nextCursor: null };
    },
  );

  app.delete(
    '/auth/sessions/:sessionId',
    {
      config: { access: 'session' },
      schema: {
        operationId: 'revokeAccountSession',
        tags: ['auth'],
        description:
          "Ends one of the signed-in user's other sessions: that browser is signed out on its next request. An id that is unknown, ended already or another user's is the same 404. The session making the call is 409 current_session (use sign-out).",
        params: Type.Object({ sessionId: Type.String({ maxLength: 64 }) }),
        response: {
          204: Type.Null({ description: 'The session was ended' }),
          ...errors(401, 404, 409),
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (!session?.id) throw new HttpError(401, 'unauthenticated', 'No session');
      const { userId, id: currentId } = session;
      const { sessionId } = request.params;
      if (!UUID.test(sessionId)) throw NO_SUCH_SESSION();
      const target = sessionId.toLowerCase();

      const outcome = await withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(userId);
        const found = await client.query(
          `select 1 from sessions
           where id = $1 and user_id = $2 and revoked_at is null and now() < expires_at
             and now() - last_seen_at <= make_interval(mins => $3)
           for update`,
          [target, userId, config.SESSION_IDLE_MINUTES],
        );
        if (found.rowCount !== 1) return 'missing' as const;
        if (target === currentId) return 'current' as const;
        await revokeSession(client, target, 'revoked_by_user');
        await record(client, request.id, userId, 'revoke_session', 'session', target);
        return 'revoked' as const;
      });

      if (outcome === 'missing') throw NO_SUCH_SESSION();
      if (outcome === 'current') {
        throw new HttpError(
          409,
          'current_session',
          'This is the session you are using; sign out instead',
        );
      }
      void reply.header('cache-control', 'no-store');
      return reply.status(204).send(null);
    },
  );
};
