import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { encounterRoutes } from './encounter-routes.js';
import { orderRoutes } from './order-routes.js';
import { printRoutes } from './print-routes.js';
import { recordRoutes } from './record-routes.js';
import { CLINICAL_SCHEMAS } from './schemas.js';

/** The module's routes: encounters, then notes and diagnoses, then orders and prescriptions, then printing. */
export const clinicalRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of CLINICAL_SCHEMAS) app.addSchema(schema);
  await app.register(encounterRoutes);
  await app.register(recordRoutes);
  await app.register(orderRoutes);
  await app.register(printRoutes);
};
