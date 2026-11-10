import type { FastifyPluginAsync } from 'fastify';
import { THEATRE_PERMISSIONS } from './permissions.js';
import { theatreRoutes } from './routes.js';
import { THEATRE_SCHEMAS } from './schemas.js';

/**
 * Operation theatre (BE-27, #180): theatres, surgery bookings that cannot overlap in a theatre,
 * for a surgeon or for a patient (exclusion constraints), starting and completing a surgery, and
 * the consumables used, which take stock out through the inventory ledger. Behind the `theatre`
 * flag; consumables need `inventory` and a patient needs `patients`. Publishes `surgery.scheduled`,
 * `surgery.started`, `surgery.completed` and `surgery.cancelled`.
 */
export const theatreFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('theatre', THEATRE_PERMISSIONS);
  for (const schema of THEATRE_SCHEMAS) app.addSchema(schema);
  await app.register(theatreRoutes);
};
