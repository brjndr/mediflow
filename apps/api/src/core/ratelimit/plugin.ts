import fp from 'fastify-plugin';
import { HttpError } from '../http/errors.js';
import { MemoryRateLimiter, type RateLimiter } from './limiter.js';

const WINDOW_MS = 60_000;

declare module 'fastify' {
  interface FastifyInstance {
    rateLimiter: RateLimiter;
  }
}

/**
 * Per-hospital and per-user request limits, so one busy hospital (or one runaway client) cannot
 * starve the others. Runs right after the session is known and before the tenant transaction
 * opens, so a refused request costs no database connection.
 *
 * Two counters per request: the whole hospital, and the signed-in user within it. Either one over
 * its limit answers 429 with `Retry-After`. The sign-in routes have their own per-address limit
 * (core/auth) because there is no session yet.
 */
export const rateLimitPlugin = fp<{ limiter?: RateLimiter }>(
  async (app, options) => {
    const limiter = options.limiter ?? new MemoryRateLimiter();
    app.decorate('rateLimiter', limiter);
    const { RATE_LIMIT_TENANT_PER_MINUTE: tenantLimit, RATE_LIMIT_USER_PER_MINUTE: userLimit } =
      app.config;

    app.addHook('onRequest', async (request) => {
      const access = request.routeOptions.config.access ?? 'tenant';
      const session = request.session;
      if (access !== 'tenant' || request.is404 || !session?.tenantId) return;

      // The user's own bucket first: a user who is over their limit is refused without touching the
      // hospital's, so one runaway client cannot use up everyone else's share.
      const user = await limiter.hit(
        `user:${session.tenantId}:${session.userId}`,
        userLimit,
        WINDOW_MS,
      );
      const hospital = user.allowed
        ? await limiter.hit(`tenant:${session.tenantId}`, tenantLimit, WINDOW_MS)
        : user;
      if (!hospital.allowed) {
        request.log.warn({ event: 'rate_limited' }, 'request rate limited');
        throw new HttpError(429, 'rate_limited', 'Too many requests, retry later', {
          'retry-after': String(hospital.retryAfterSeconds),
        });
      }
    });
  },
  { name: 'rate-limit', dependencies: ['session'] },
);
