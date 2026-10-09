import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type pg from 'pg';
import { HttpError } from '../http/errors.js';
import { errors, ref } from '../http/schemas.js';
import { withAuthTransaction } from './db.js';
import { acceptInvite, inspectInvite } from './invites.js';
import {
  beginEnrollment,
  checkTotp,
  confirmEnrollment,
  disableMfa,
  regenerateRecoveryCodes,
} from './mfa.js';
import { MAX_PASSWORD_LENGTH, verifyPassword, type PasswordProblem } from './password.js';
import { requestPasswordReset, resetPassword, sendPasswordReset } from './password-reset.js';

export const InvitePreview = Type.Object(
  {
    email: Type.String(),
    hospitalName: Type.String(),
    needsPassword: Type.Boolean({
      description: 'False when this person already has an account: they only accept.',
    }),
  },
  { $id: 'InvitePreview' },
);

export const MfaEnrollment = Type.Object(
  {
    secret: Type.String({ description: 'Base32, for typing into an authenticator by hand.' }),
    otpauthUri: Type.String({ description: 'For the QR code.' }),
  },
  { $id: 'MfaEnrollment' },
);

export const RecoveryCodes = Type.Object(
  {
    recoveryCodes: Type.Array(Type.String(), {
      description: 'One-time codes. Returned this once and never again.',
    }),
  },
  { $id: 'RecoveryCodes' },
);

export const ACCOUNT_SCHEMAS = [InvitePreview, MfaEnrollment, RecoveryCodes] as const;

const Token = Type.String({ minLength: 1, maxLength: 128 });
const Password = Type.String({ minLength: 1, maxLength: 1024 });
const Code = Type.String({ minLength: 1, maxLength: 32 });

/** One answer for a link that never existed, was used, was withdrawn or has expired. */
const INVALID_TOKEN = () =>
  new HttpError(400, 'invalid_token', 'This link is not valid or has expired');

const PASSWORD_PROBLEMS: Record<PasswordProblem, [code: string, message: string]> = {
  too_short: ['password_too_short', 'The password needs at least 12 characters'],
  too_long: ['password_too_long', 'The password is too long'],
  too_common: ['password_too_common', 'The password is too easy to guess'],
};
const weakPassword = (problem: PasswordProblem) =>
  new HttpError(400, ...PASSWORD_PROBLEMS[problem]);

export const accountRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const { pool } = app.database;
  // Everything here takes a secret or a guessable code, so all of it is limited per address.
  const rateLimit = { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: 60_000 };

  app.post(
    '/auth/invite/inspect',
    {
      config: { access: 'public', rateLimit },
      schema: {
        operationId: 'inspectInvite',
        tags: ['auth'],
        description:
          'What the invite screen shows before the person accepts: which hospital, which email, and whether a password has to be chosen. The token is in the body, not the URL, so it is not logged.',
        body: Type.Object({ token: Token }),
        response: { 200: ref(InvitePreview), ...errors(400, 403, 429) },
      },
    },
    async (request, reply) => {
      const preview = await withAuthTransaction(pool, (transaction) =>
        inspectInvite(transaction, request.body.token),
      );
      if (!preview) throw INVALID_TOKEN();
      void reply.header('cache-control', 'no-store');
      return preview;
    },
  );

  app.post(
    '/auth/invite/accept',
    {
      config: { access: 'public', rateLimit },
      schema: {
        operationId: 'acceptInvite',
        tags: ['auth'],
        description:
          'Accepts an invite. Someone new sets their password here (400 password_required without one). Someone with an account needs only the token. The link works once. The person then signs in.',
        body: Type.Object({ token: Token, password: Type.Optional(Password) }),
        response: { 204: Type.Null({ description: 'Accepted' }), ...errors(400, 403, 429) },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body;
      const result = await withAuthTransaction(pool, (transaction) =>
        acceptInvite(transaction, token, password),
      );
      if (result === 'invalid') throw INVALID_TOKEN();
      if (result === 'password_required') {
        throw new HttpError(400, 'password_required', 'Choose a password to accept the invite');
      }
      if (result !== 'accepted') throw weakPassword(result);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/password/forgot',
    {
      config: { access: 'public', rateLimit },
      schema: {
        operationId: 'forgotPassword',
        tags: ['auth'],
        description:
          'Emails a reset link if the address has an account. The answer is the same either way, so it cannot be used to find accounts.',
        body: Type.Object({ email: Type.String({ minLength: 1, maxLength: 254 }) }),
        response: {
          204: Type.Null({ description: 'Done, whether or not an email is sent' }),
          ...errors(400, 403, 429),
        },
      },
    },
    async (request, reply) => {
      const issued = await withAuthTransaction(pool, (transaction) =>
        requestPasswordReset(transaction, config, request.body.email),
      );
      if (issued) {
        // Not awaited: how long the mail server takes must not show in the response time, which
        // would tell an account apart from no account. A failure is logged without the address.
        void sendPasswordReset(app.notifier, issued).catch(() => {
          request.log.warn({ event: 'password_reset_email_failed' }, 'reset email not sent');
        });
      }
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/password/reset',
    {
      config: { access: 'public', rateLimit },
      schema: {
        operationId: 'resetPassword',
        tags: ['auth'],
        description:
          'Sets a new password with a reset link. The link works once. Every session of the user ends.',
        body: Type.Object({ token: Token, password: Password }),
        response: { 204: Type.Null({ description: 'Password changed' }), ...errors(400, 403, 429) },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body;
      const result = await withAuthTransaction(pool, (transaction) =>
        resetPassword(transaction, token, password),
      );
      if (result === 'invalid') throw INVALID_TOKEN();
      if (result !== 'reset') throw weakPassword(result);
      // This browser's session, if it had one, has just ended with the others.
      app.auth.clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );

  /** The signed-in user re-enters their password before changing how they sign in. */
  async function confirmPassword(client: pg.PoolClient, userId: string, password: string) {
    const { rows } = await client.query<{ secret_hash: string }>(
      "select secret_hash from user_identities where user_id = $1 and provider = 'password'",
      [userId],
    );
    const hash = rows[0]?.secret_hash;
    const matches =
      hash !== undefined &&
      password.length <= MAX_PASSWORD_LENGTH &&
      (await verifyPassword(hash, password));
    // Not a 401: the session is fine, and the web app treats 401 as signed out.
    if (!matches) throw new HttpError(403, 'invalid_password', 'The password is not correct');
  }
  const INVALID_CODE = () => new HttpError(400, 'invalid_mfa_code', 'That code is not valid');

  app.post(
    '/auth/mfa/enroll',
    {
      config: { access: 'session', rateLimit },
      schema: {
        operationId: 'enrollMfa',
        tags: ['auth'],
        description:
          'Starts setting up an authenticator app and returns its secret. Sign-in does not change until a code is confirmed. Calling it again before that starts over.',
        body: Type.Object({ password: Password }),
        response: { 200: ref(MfaEnrollment), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request, reply) => {
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      const enrollment = await withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(userId);
        await confirmPassword(client, userId, request.body.password);
        const { rows } = await client.query<{ email: string }>(
          'select email from users where id = $1',
          [userId],
        );
        return beginEnrollment(client, config, { id: userId, email: rows[0]?.email ?? '' });
      });
      if (!enrollment) {
        throw new HttpError(409, 'mfa_already_enabled', 'An authenticator is already set up');
      }
      void reply.header('cache-control', 'no-store');
      return enrollment;
    },
  );

  app.post(
    '/auth/mfa/confirm',
    {
      config: { access: 'session', rateLimit },
      schema: {
        operationId: 'confirmMfa',
        tags: ['auth'],
        description:
          'Finishes setup with a code from the authenticator. From now on sign-in asks for a code. Returns the recovery codes, once.',
        body: Type.Object({ code: Code }),
        response: { 200: ref(RecoveryCodes), ...errors(400, 401, 403, 429) },
      },
    },
    async (request, reply) => {
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      const recoveryCodes = await withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(userId);
        return confirmEnrollment(client, config, userId, request.body.code.trim());
      });
      if (!recoveryCodes) throw INVALID_CODE();
      void reply.header('cache-control', 'no-store');
      return { recoveryCodes };
    },
  );

  app.post(
    '/auth/mfa/recovery-codes',
    {
      config: { access: 'session', rateLimit },
      schema: {
        operationId: 'regenerateRecoveryCodes',
        tags: ['auth'],
        description:
          'Replaces the recovery codes. Needs the password and a code from the authenticator itself.',
        body: Type.Object({ password: Password, code: Code }),
        response: { 200: ref(RecoveryCodes), ...errors(400, 401, 403, 429) },
      },
    },
    async (request, reply) => {
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      const { password, code } = request.body;
      const recoveryCodes = await withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(userId);
        await confirmPassword(client, userId, password);
        if (!(await checkTotp(client, config, userId, code.trim()))) return null;
        return regenerateRecoveryCodes(client, userId);
      });
      if (!recoveryCodes) throw INVALID_CODE();
      void reply.header('cache-control', 'no-store');
      return { recoveryCodes };
    },
  );

  app.post(
    '/auth/mfa/disable',
    {
      config: { access: 'session', rateLimit },
      schema: {
        operationId: 'disableMfa',
        tags: ['auth'],
        description:
          'Removes the authenticator and its recovery codes. Needs the password and a current code.',
        body: Type.Object({ password: Password, code: Code }),
        response: { 204: Type.Null({ description: 'Removed' }), ...errors(400, 401, 403, 429) },
      },
    },
    async (request, reply) => {
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      const { password, code } = request.body;
      const done = await withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(userId);
        await confirmPassword(client, userId, password);
        if (!(await checkTotp(client, config, userId, code.trim()))) return false;
        await disableMfa(client, userId);
        return true;
      });
      if (!done) throw INVALID_CODE();
      return reply.status(204).send(null);
    },
  );
};
