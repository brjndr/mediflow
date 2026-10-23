import type { FastifyPluginAsync } from 'fastify';
import { CLINICAL_PERMISSIONS } from './permissions.js';
import { clinicalRoutes } from './routes.js';

/**
 * Clinical: the encounter (the visit every clinical, ordering and billing record attaches to),
 * its notes and diagnoses, and the one table of orders (lab, imaging, procedure, medication,
 * diet) with the prescriptions that place medication orders. Behind the `clinical` module flag.
 * Publishes `encounter.opened`, `encounter.closed`, `encounter.cancelled`, `order.placed`,
 * `order.cancelled` and `order.completed`; the lab, radiology, pharmacy and billing modules act
 * on those, never by a call.
 */
export const clinicalFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('clinical', CLINICAL_PERMISSIONS);
  await app.register(clinicalRoutes);
};

/**
 * For the laboratory: a lab order, and moving it on as its sample and results go, so the
 * laboratory never writes the orders table. The order's enums, for its own answers.
 */
export { labOrder, moveLabOrder, type LabOrder } from './lab.js';
export { OrderPriority, OrderStatus } from './schemas.js';
