import type { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './routes.js';

/**
 * A feature is one Fastify plugin: this file registers its routes, hooks, event subscribers and
 * jobs. It is encapsulated, so nothing it decorates or hooks leaks into other features. Adding a
 * feature is a new folder plus one `app.register` line in app.ts.
 *
 * The full layout of a feature folder (routes.ts, permissions.ts, schema.ts, events.ts,
 * settings.ts) is described in apps/api/CLAUDE.md. Health needs only routes.
 */
export const healthFeature: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
};
