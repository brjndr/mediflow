import type { FastifyPluginAsync } from 'fastify';
import { OFFBOARD_JOB, prepareOffboarding, type OffboardJob } from './jobs.js';
import { platformRoutes } from './routes.js';
import { PLATFORM_SCHEMAS } from './schemas.js';

/**
 * Platform administration: onboarding hospitals and operating them (`/platform/*`). For the
 * product's operators only (`access: 'platform'`, core/platform): no hospital's staff reach it
 * whatever their permissions, and it has no access to patient data (database role
 * `mediflow_platform`). Not behind a module flag, since a hospital cannot switch it on or off.
 * Read `CLAUDE.md` in this folder before changing it.
 */
export const platformFeature: FastifyPluginAsync = async (app) => {
  for (const schema of PLATFORM_SCHEMAS) app.addSchema(schema);
  app.jobs.work<OffboardJob>(OFFBOARD_JOB, async (job) => {
    await prepareOffboarding(app.database.pool, job);
  });
  await app.register(platformRoutes);
};
