import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { HttpError } from '../http/errors.js';

/** Who is making the request and which hospital they are working in. Held on the server. */
export interface Session {
  userId: string;
  /** Null until a user who works at several hospitals picks one. */
  tenantId: string | null;
}

/**
 * Turns a request into a session, or null when there is none. The real resolver (httpOnly cookie
 * to a session row in Postgres) arrives with authentication in M2. Until then the default
 * resolves nothing, so every route that needs a session answers 401.
 */
export type SessionResolver = (request: FastifyRequest) => Promise<Session | null>;

/**
 * What a route needs before its handler runs:
 * - `tenant` (the default): a session with an active hospital. The request then runs inside that
 *   hospital's transaction (see core/tenancy).
 * - `session`: a signed-in user, with or without an active hospital.
 * - `public`: nothing. Health checks and, later, login.
 *
 * The default is the strictest, so a route that forgets to say is closed, not open.
 */
export type RouteAccess = 'tenant' | 'session' | 'public';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

export const sessionPlugin = fp<{ resolveSession?: SessionResolver }>(
  async (app, options) => {
    const resolveSession: SessionResolver = options.resolveSession ?? (async () => null);
    app.decorateRequest('session', null);

    app.addHook('onRequest', async (request) => {
      const access = request.routeOptions.config.access ?? 'tenant';
      // An unknown route has no config and is answered by the not-found handler.
      if (access === 'public' || request.is404) return;
      request.session = await resolveSession(request);
      if (!request.session) throw new HttpError(401, 'unauthenticated', 'No session');
    });
  },
  { name: 'session' },
);
