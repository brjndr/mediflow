import { randomUUID } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './core/config/config.js';
import { dbPlugin } from './core/db/plugin.js';
import { registerErrorHandling } from './core/http/errors.js';
import { loggerOptions } from './core/logging/logger.js';
import { openApiPlugin } from './core/openapi/plugin.js';
import type { Notifier } from './core/notifier/notifier.js';
import { notifierPlugin } from './core/notifier/plugin.js';
import { sessionPlugin, type SessionResolver } from './core/session/plugin.js';
import { tenancyPlugin } from './core/tenancy/plugin.js';
import { tenantRoutes } from './core/tenancy/routes.js';
import { healthFeature } from './features/health/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export interface AppOptions {
  /**
   * How a request becomes a session. Omitted in production until authentication exists (M2), in
   * which case every route that needs a session answers 401. Tests pass their own.
   */
  resolveSession?: SessionResolver;
  /** How staff email is sent. Defaults to SMTP. Tests pass an in-memory notifier. */
  notifier?: Notifier;
}

/**
 * Builds the API without starting it, so tests can drive it in-process. Core plugins are
 * registered first, then one line per feature.
 *
 * Every request passes through the core hooks in this order: session (who is asking), tenancy
 * (a transaction scoped to their hospital). A route is closed unless it says otherwise: the
 * default `access` is `tenant`.
 */
export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config),
    // Ids are generated here and never taken from the client, so a log line cannot be forged.
    genReqId: () => randomUUID(),
    // Stop reading a request body past this size (1 MiB). File uploads go to object storage.
    bodyLimit: 1_048_576,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);
  registerErrorHandling(app);

  // Core. OpenAPI comes first: it has to see every route as it is registered.
  await app.register(openApiPlugin);
  await app.register(dbPlugin);
  await app.register(notifierPlugin, { notifier: options.notifier });
  await app.register(sessionPlugin, { resolveSession: options.resolveSession });
  await app.register(tenancyPlugin);
  await app.register(tenantRoutes);

  // Features: one line each.
  await app.register(healthFeature);

  return app;
}
