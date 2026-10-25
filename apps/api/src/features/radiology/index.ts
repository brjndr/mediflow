import type { FastifyPluginAsync } from 'fastify';
import { RADIOLOGY_PERMISSIONS } from './permissions.js';
import { radiologyRoutes } from './routes.js';

/**
 * Radiology: the worklist of imaging orders, their studies (scheduled, then performed) and their
 * reports (a draft, signed, then addenda).
 * Behind the `radiology` module flag. Moves imaging orders on through the clinical module's
 * `moveImagingOrder`, never by writing its table. Publishes `imaging.scheduled`,
 * `imaging.unscheduled`, `imaging.performed`, and for reports (#97) `imaging.reported` and
 * `imaging.addendum_added`. Image uploads are #99.
 */
export const radiologyFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('radiology', RADIOLOGY_PERMISSIONS);
  await app.register(radiologyRoutes);
};
