import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

/**
 * Security headers on every answer (#1048). The API serves JSON and files, never a page, so its
 * policy allows nothing to load or frame. The static SPA host sends its own (`apps/web/public/_headers`).
 * HSTS is sent whatever the transport: a browser ignores it over plain http, and production is TLS only.
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
}
