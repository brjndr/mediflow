import type { FastifyPluginAsync } from 'fastify';
import {
  closeUnsentImages,
  imageRoutes,
  scanImage,
  SCAN_JOB,
  UNSENT_JOB,
  type ScanJob,
} from './images.js';
import { RADIOLOGY_PERMISSIONS } from './permissions.js';
import { radiologyRoutes } from './routes.js';

/**
 * Radiology: the worklist of imaging orders, their studies (scheduled, then performed) and their
 * reports (a draft, signed, then addenda).
 * Behind the `radiology` module flag. Moves imaging orders on through the clinical module's
 * `moveImagingOrder`, never by writing its table. Publishes `imaging.scheduled`,
 * `imaging.unscheduled`, `imaging.performed`, and for reports (#97) `imaging.reported` and
 * `imaging.addendum_added`. Image uploads (#99) go through signed links and a malware scan job.
 */
export const radiologyFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('radiology', RADIOLOGY_PERMISSIONS);
  await app.register(radiologyRoutes);
  await app.register(imageRoutes);
  app.jobs.work<ScanJob>(SCAN_JOB, (job) => scanImage(app, job));
  app.jobs.work(UNSENT_JOB, async () => {
    await closeUnsentImages(app);
  });
  app.jobs.schedule(UNSENT_JOB, '15 * * * *');
};
