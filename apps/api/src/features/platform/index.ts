import type { FastifyPluginAsync } from 'fastify';
import {
  DELETE_JOB,
  DELETE_SWEEP_JOB,
  runDeletion,
  sweepDeletions,
  type DeleteJob,
} from './deletion.js';
import { DELETION_REMINDER_JOB, sendDeletionReminders } from './deletion-reminders.js';
import { deletionRoutes } from './deletion-routes.js';
import { exportRoutes } from './export-routes.js';
import { EXPORT_JOB, runExport, type ExportJob } from './export.js';
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
  app.jobs.work<ExportJob>(EXPORT_JOB, async (job) => {
    await runExport(app.database.pool, app.files, job);
  });
  app.jobs.work<DeleteJob>(DELETE_JOB, async (job) => {
    await runDeletion(app.database.pool, app.files, job, app.log);
  });
  app.jobs.work(DELETE_SWEEP_JOB, async () => {
    await sweepDeletions(app.database.pool, app.files, app.jobs, app.log);
  });
  app.jobs.schedule(DELETE_SWEEP_JOB, '*/15 * * * *');
  app.jobs.work(DELETION_REMINDER_JOB, async () => {
    await sendDeletionReminders(app.database.pool, app.notifier, app.log);
  });
  app.jobs.schedule(DELETION_REMINDER_JOB, '0 5 * * *');
  await app.register(platformRoutes);
  await app.register(exportRoutes);
  await app.register(deletionRoutes);
};
