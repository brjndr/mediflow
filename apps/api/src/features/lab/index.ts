import type { FastifyPluginAsync } from 'fastify';
import { LAB_PERMISSIONS } from './permissions.js';
import { labRoutes } from './routes.js';

/**
 * The laboratory: the worklist of lab orders, their samples (collected, received, rejected) and
 * their results (entered, verified, corrected). Behind the `laboratory` module flag. Moves lab
 * orders on through the clinical module's `moveLabOrder`, never by writing its table. Publishes
 * `lab.sample_collected`, `lab.sample_rejected`, `lab.result_verified` and `lab.critical_value`.
 */
export const labFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('laboratory', LAB_PERMISSIONS);
  await app.register(labRoutes);
};
