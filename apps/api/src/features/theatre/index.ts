import type { FastifyPluginAsync } from 'fastify';
import { THEATRE_PERMISSIONS } from './permissions.js';
import { operationRoutes } from './operation.js';
import { OPERATION_SCHEMAS } from './operation-schemas.js';
import { periopRoutes } from './periop.js';
import { PERIOP_SCHEMAS } from './periop-schemas.js';
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
  for (const schema of PERIOP_SCHEMAS) app.addSchema(schema);
  for (const schema of OPERATION_SCHEMAS) app.addSchema(schema);
  await app.register(theatreRoutes);
  await app.register(periopRoutes);
  await app.register(operationRoutes);
};
