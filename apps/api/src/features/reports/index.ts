import type { FastifyPluginAsync } from 'fastify';
import { RUN_JOB, SWEEP_JOB, runReport, sweepReports, type RunJob } from './jobs.js';
import { REPORT_PERMISSIONS } from './permissions.js';
import { reportRoutes } from './routes.js';

/**
 * Operational reports (BE-14, #123): OPD census, revenue, laboratory turnaround and stock, read
 * from the replica, large ones made by a job and kept with a CSV file for download. Behind the
 * `reports` module flag, with `report:read` and `report:export`, the admin's by default.
 */
export const reportsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('reports', REPORT_PERMISSIONS);
  await app.register(reportRoutes);

  app.jobs.work<RunJob>(RUN_JOB, (job) =>
    runReport(app.database, app.files, app.config.REPORT_RUN_TIMEOUT_MS, job),
  );
  app.jobs.work(SWEEP_JOB, async () => {
    const failed = await sweepReports(app.database.pool, app.files);
    if (failed.length > 0) {
      app.log.warn(
        { event: 'report_file_delete_failed', count: failed.length },
        'report files kept',
      );
    }
  });
  // Hourly, so a stalled run holds up its hospital's quota for an hour at most.
  app.jobs.schedule(SWEEP_JOB, '15 * * * *');
};
