import type { FastifyPluginAsync } from 'fastify';
import { RADIOLOGY_PERMISSIONS } from './permissions.js';
import { radiologyRoutes } from './routes.js';

/**
 * Radiology: the worklist of imaging orders and their studies (scheduled, then performed).
 * Behind the `radiology` module flag. Moves imaging orders on through the clinical module's
 * `moveImagingOrder`, never by writing its table. Publishes `imaging.scheduled`,
 * `imaging.unscheduled` and `imaging.performed`; reports and `imaging.reported` are #97 and #99.
 */
export const radiologyFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('radiology', RADIOLOGY_PERMISSIONS);
  await app.register(radiologyRoutes);
};
