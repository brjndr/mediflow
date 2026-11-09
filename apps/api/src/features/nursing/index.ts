import type { FastifyPluginAsync } from 'fastify';
import { NURSING_PERMISSIONS } from './permissions.js';
import { nursingRoutes } from './routes.js';

/**
 * Nursing and ward care (BE-24): ward vital signs, the medication administration chart, progress
 * notes with their history, the diet orders of a stay (read only) and requests for ward stock,
 * all of an admitted patient. Behind the `nursing` module flag; the stay is the `admissions`
 * module's, so that flag must be on too. Reads the clinical module's orders and writes the
 * inventory's indents only through their `index.ts`. Publishes `vitals.recorded`,
 * `medication.administered`, `progressnote.created`, `progressnote.updated` and
 * `ward.stockrequested`.
 */
export const nursingFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('nursing', NURSING_PERMISSIONS);
  await app.register(nursingRoutes);
};
