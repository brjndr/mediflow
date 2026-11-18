import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/config.js';

/** The origins a browser may call the API from: the app's own and the listed extras (#1061). */
export function allowedOrigins(
  config: Pick<Config, 'APP_BASE_URL' | 'CORS_ALLOWED_ORIGINS'>,
): Set<string> {
  const list = (config.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => new URL(value).origin);
  return new Set([new URL(config.APP_BASE_URL).origin, ...list]);
}

/**
 * Strict CORS. The web app reaches the API through its own origin, so a browser needs no CORS
 * header today; the allowlist is the app's origin plus `CORS_ALLOWED_ORIGINS`, never `*`. A request
 * with no Origin (same origin GET, curl, server to server) is untouched. A preflight from any other
 * origin is refused with 403, and an actual request from one gets no CORS header, so the browser
 * withholds the answer (writes are refused by the cross-site check in `core/auth`).
 */
export async function registerCors(app: FastifyInstance): Promise<void> {
  const allowed = allowedOrigins(app.config);
  await app.register(cors, {
    origin: (origin, done) => done(null, origin === undefined || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Tenant-ID'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
    strictPreflight: true,
    preflightContinue: false,
    hook: 'onRequest',
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (
      request.method === 'OPTIONS' &&
      request.headers['access-control-request-method'] !== undefined &&
      origin !== undefined &&
      !allowed.has(origin)
    ) {
      return reply.status(403).send({
        error: { code: 'origin_not_allowed', message: 'Origin not allowed', requestId: request.id },
      });
    }
  });
}
