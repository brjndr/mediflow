import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../http/errors.js';
import { errors, ref } from '../http/schemas.js';
import { withAuthTransaction } from './db.js';
import { authenticate } from './login.js';
import { MAX_PASSWORD_LENGTH } from './password.js';
import { createSession, revokeSessionByToken, switchTenant } from './sessions.js';
import { loadSessionView, Session } from './session-view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One message for every failed sign-in. It must never say which part was wrong. */
const INVALID_CREDENTIALS = () =>
  new HttpError(
    401,
    'invalid_credentials',
    'Email or password is incorrect, or the account is temporarily locked',
  );
const NOT_A_MEMBER = () => new HttpError(403, 'not_a_member', 'No membership in that tenant');

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { config } = app;
  const { pool } = app.database;

  app.post(
    '/auth/login',
    {
      config: {
        access: 'public',
        // Per client address, across all accounts. Account lockout is separate (see login.ts).
        rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: 60_000 },
      },
      schema: {
        operationId: 'login',
        tags: ['auth'],
        description:
          'Signs in with email and password and starts a session, returned as an httpOnly cookie. Every failure has the same answer.',
        body: Type.Object({
          email: Type.String({ minLength: 1, maxLength: 254 }),
          password: Type.String({ minLength: 1, maxLength: 1024 }),
        }),
        response: { 200: ref(Session), ...errors(400, 401, 403, 429) },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const previousToken = app.auth.tokenOf(request);

      // The transaction commits whether or not the password was right, because a wrong one has
      // to be counted. The 401 is thrown afterwards.
      const result = await withAuthTransaction(pool, async (transaction) => {
        const { client, identify } = transaction;
        const userId =
          password.length > MAX_PASSWORD_LENGTH
            ? null
            : await authenticate(transaction, config, email, password);
        if (!userId) return null;

        await identify(userId);
        // A browser that signs in again gets a new session. The old one is ended, so a token
        // planted before sign-in is worthless after it.
        await revokeSessionByToken(client, previousToken, 'replaced');

        const memberships = await client.query<{ tenant_id: string }>(
          "select tenant_id from memberships where user_id = $1 and status = 'active'",
          [userId],
        );
        // One hospital: straight in. Several: none is active until the user picks.
        const tenantId =
          memberships.rows.length === 1 ? (memberships.rows[0]?.tenant_id ?? null) : null;
        const { token } = await createSession(client, config, { userId, tenantId });
        return { token, view: await loadSessionView(client, userId, tenantId) };
      });

      if (!result) throw INVALID_CREDENTIALS();
      app.auth.setSessionCookie(reply, result.token);
      void reply.header('cache-control', 'no-store');
      return result.view;
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { access: 'public' },
      schema: {
        operationId: 'logout',
        tags: ['auth'],
        description:
          'Ends the session, on the server and in the browser. Succeeds whether or not there was one.',
        response: { 204: Type.Null({ description: 'Signed out' }), ...errors(403) },
      },
    },
    async (request, reply) => {
      const token = app.auth.tokenOf(request);
      await withAuthTransaction(pool, ({ client }) =>
        revokeSessionByToken(client, token, 'logout'),
      );
      app.auth.clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/session',
    {
      config: { access: 'session' },
      schema: {
        operationId: 'getSession',
        tags: ['auth'],
        description:
          'Bootstraps the app in one request: the signed-in user, the active tenant with its config, and the effective access policy. Private per session, never CDN-cached. Session routes ignore X-Tenant-ID, so a stale tab can always reload its session.',
        response: { 200: ref(Session), ...errors(401) },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new HttpError(401, 'unauthenticated', 'No session');
      void reply.header('cache-control', 'no-store');
      return withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(session.userId);
        return loadSessionView(client, session.userId, session.tenantId);
      });
    },
  );

  app.post(
    '/session/switch-tenant',
    {
      config: { access: 'session' },
      schema: {
        operationId: 'switchTenant',
        tags: ['auth'],
        description:
          'Rebinds the session to another hospital the user belongs to and returns the new session. Affects every tab.',
        body: Type.Object({ tenantId: Type.String({ minLength: 1, maxLength: 64 }) }),
        response: { 200: ref(Session), ...errors(400, 401, 403) },
      },
    },
    async (request, reply) => {
      const sessionId = request.session?.id;
      if (!request.session || !sessionId) {
        throw new HttpError(401, 'unauthenticated', 'No session');
      }
      const session = { ...request.session, id: sessionId };
      const { tenantId } = request.body;
      // An id that is not a hospital's, and a hospital the user is not in, get the same answer.
      if (!UUID.test(tenantId)) throw NOT_A_MEMBER();

      const result = await withAuthTransaction(pool, async (transaction) => {
        await transaction.identify(session.userId);
        const switched = await switchTenant(transaction, session, tenantId);
        if (!switched) return null;
        return {
          token: switched.token,
          view: await loadSessionView(transaction.client, session.userId, tenantId),
        };
      });

      if (!result) throw NOT_A_MEMBER();
      app.auth.setSessionCookie(reply, result.token);
      void reply.header('cache-control', 'no-store');
      return result.view;
    },
  );
};
