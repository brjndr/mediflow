import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { HttpError } from '../http/errors.js';
import { MemoryRateLimiter, type RateLimiter } from './limiter.js';

const WINDOW_MS = 60_000;

type Costly = 'search' | 'report' | 'upload';

/** Which tighter budget a route falls under, from its route pattern (no edit to each route). */
export function costlyClass(method: string, url: string): Costly | null {
  if (url.endsWith('/search')) return 'search';
  if (url === '/reports' || url.startsWith('/reports/')) return 'report';
  if (method === 'POST' && (url.startsWith('/imports') || /\/(images|documents)$/.test(url))) {
    return 'upload';
  }
  return null;
}

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
    const {
      RATE_LIMIT_TENANT_PER_MINUTE: tenantLimit,
      RATE_LIMIT_USER_PER_MINUTE: userLimit,
      RATE_LIMIT_SEARCH_PER_MINUTE,
      RATE_LIMIT_REPORT_PER_MINUTE,
      RATE_LIMIT_UPLOAD_PER_MINUTE,
    } = app.config;
    const costlyLimit: Record<Costly, number> = {
      search: RATE_LIMIT_SEARCH_PER_MINUTE,
      report: RATE_LIMIT_REPORT_PER_MINUTE,
      upload: RATE_LIMIT_UPLOAD_PER_MINUTE,
    };

    // A runaway client is refused thousands of times a minute: log the first refusal of each user
    // in a window, not every one, so the log cannot be flooded. The map is swept as it grows.
    const loggedAt = new Map<string, number>();
    const refuse = (request: FastifyRequest, userId: string, retryAfterSeconds: number): never => {
      const now = Date.now();
      if (loggedAt.size > 10_000) {
        for (const [key, at] of loggedAt) if (now - at >= WINDOW_MS) loggedAt.delete(key);
      }
      const last = loggedAt.get(userId);
      if (last === undefined || now - last >= WINDOW_MS) {
        loggedAt.set(userId, now);
        request.log.warn({ event: 'rate_limited' }, 'request rate limited');
      }
      throw new HttpError(429, 'rate_limited', 'Too many requests, retry later', {
        'retry-after': String(retryAfterSeconds),
      });
    };

    app.addHook('onRequest', async (request) => {
      const access = request.routeOptions.config.access ?? 'tenant';
      const session = request.session;
      if (request.is404 || !session) return;

      if (access === 'session') {
        // No hospital is bound on these routes (GET /session, switching hospital), so the user alone
        // is counted, in a bucket of their own that the hospital routes do not share.
        if (!session.userId) return;
        const own = await limiter.hit(`session:${session.userId}`, userLimit, WINDOW_MS);
        if (!own.allowed) refuse(request, session.userId, own.retryAfterSeconds);
        return;
      }
      if (access !== 'tenant' || !session.tenantId) return;

      // Search, report and upload routes have a tighter budget of their own, counted first so a
      // refused one uses up neither the user's general allowance nor the hospital's.
      const costly = costlyClass(request.method, request.routeOptions.url ?? '');
      if (costly) {
        const own = await limiter.hit(
          `${costly}:${session.tenantId}:${session.userId}`,
          costlyLimit[costly],
          WINDOW_MS,
        );
        if (!own.allowed) refuse(request, session.userId, own.retryAfterSeconds);
      }

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
      if (!hospital.allowed) refuse(request, session.userId, hospital.retryAfterSeconds);
    });
  },
  { name: 'rate-limit', dependencies: ['session'] },
);
