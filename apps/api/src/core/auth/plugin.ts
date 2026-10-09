import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { HttpError } from '../http/errors.js';
import type { Session, SessionResolver } from '../session/plugin.js';
import { withAuthTransaction } from './db.js';
import { resolveSession } from './sessions.js';
import { AUTH_SCHEMAS } from './session-view.js';
import { ACCOUNT_SCHEMAS } from './account-routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: {
      /** The session for this request's cookie, or null. Sends a new cookie when the token was rotated. */
      resolveSession: SessionResolver;
      /** The raw token from the session cookie, if any. */
      tokenOf(request: FastifyRequest): string | undefined;
      setSessionCookie(reply: FastifyReply, token: string): void;
      clearSessionCookie(reply: FastifyReply): void;
    };
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Authentication plumbing shared by the whole app: the session cookie, the default session
 * resolver, the cross-site request check and the rate limiter. The routes are in routes.ts.
 */
export const authPlugin = fp(
  async (app) => {
    const { config } = app;
    const secure = config.NODE_ENV === 'production';
    // The __Host- prefix makes the browser refuse the cookie unless it is Secure, has Path=/ and
    // no Domain, so no other site or subdomain can set or overwrite it.
    const cookieName = secure ? '__Host-mediflow_session' : 'mediflow_session';
    const cookieOptions = {
      httpOnly: true, // Not readable by scripts.
      secure,
      sameSite: 'lax', // Not sent on cross-site subrequests or form posts.
      path: '/',
    } as const;
    const appOrigin = new URL(config.APP_BASE_URL).origin;

    await app.register(cookie);
    // Per-route only. Routes opt in with `config.rateLimit`.
    await app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (_request, context) => {
        const error = new HttpError(429, 'rate_limited', 'Too many attempts. Try again shortly.');
        // The plugin reads the status from the error it is given.
        return Object.assign(error, { statusCode: context.statusCode });
      },
    });
    for (const schema of [...AUTH_SCHEMAS, ...ACCOUNT_SCHEMAS]) app.addSchema(schema);

    // Cross-site request forgery: the session cookie is sent automatically, so a request that
    // changes something must be shown to come from the web app itself. Browsers state where a
    // request comes from in Origin (always present on cross-origin writes) and Sec-Fetch-Site.
    // Requests with neither come from non-browser clients, which carry no ambient cookie.
    app.addHook('onRequest', async (request) => {
      if (SAFE_METHODS.has(request.method)) return;
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      const crossSite =
        origin !== undefined
          ? origin !== appOrigin
          : site !== undefined && site !== 'same-origin' && site !== 'none';
      if (crossSite) throw new HttpError(403, 'cross_site_request', 'Cross-site request refused');
    });

    const tokenOf = (request: FastifyRequest) => request.cookies[cookieName];
    const setSessionCookie = (reply: FastifyReply, token: string) => {
      void reply.setCookie(cookieName, token, {
        ...cookieOptions,
        // The browser drops the cookie when the session can no longer be valid anyway.
        maxAge: config.SESSION_ABSOLUTE_HOURS * 3600,
      });
    };
    const clearSessionCookie = (reply: FastifyReply) => {
      void reply.clearCookie(cookieName, cookieOptions);
    };

    app.decorate('auth', {
      tokenOf,
      setSessionCookie,
      clearSessionCookie,
      async resolveSession(request, reply): Promise<Session | null> {
        const token = tokenOf(request);
        if (!token) return null;
        const resolved = await withAuthTransaction(app.database.pool, (transaction) =>
          resolveSession(transaction, config, token),
        );
        if (!resolved.ok) {
          clearSessionCookie(reply);
          return null;
        }
        if (resolved.rotatedToken) setSessionCookie(reply, resolved.rotatedToken);
        return resolved.session;
      },
    });
  },
  { name: 'auth', dependencies: ['db'] },
);
