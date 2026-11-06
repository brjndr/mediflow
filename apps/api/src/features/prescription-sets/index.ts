import type { FastifyPluginAsync } from 'fastify';
import { PRESCRIPTION_SET_PERMISSIONS } from './permissions.js';
import { prescriptionSetRoutes } from './routes.js';

/**
 * Prescription sets and favourite medicines (#394): named lists of medicine lines a prescriber
 * loads into a prescription, the hospital's or their own, and the medicines a doctor reaches for
 * first. Loading a set creates nothing: the prescription is written, and checked, as ever.
 * Behind the `clinical` module flag.
 */
export const prescriptionSetsFeature: FastifyPluginAsync = async (app) => {
  // Under the clinical module, whose switch the routes check: a module id of its own would be
  // offered to a platform admin as a switch that does nothing.
  app.permissions.register('clinical', PRESCRIPTION_SET_PERMISSIONS);
  await app.register(prescriptionSetRoutes);
};
