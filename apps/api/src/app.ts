import { randomUUID } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './core/config/config.js';
import { dbPlugin } from './core/db/plugin.js';
import { registerErrorHandling } from './core/http/errors.js';
import { loggerOptions } from './core/logging/logger.js';
import { openApiPlugin } from './core/openapi/plugin.js';
import { healthFeature } from './features/health/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

/**
 * Builds the API without starting it, so tests can drive it in-process. Core plugins are
 * registered first, then one line per feature.
 */
export async function buildApp(config: Config): Promise<FastifyInstance> {
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

  // Features: one line each.
  await app.register(healthFeature);

  return app;
}
