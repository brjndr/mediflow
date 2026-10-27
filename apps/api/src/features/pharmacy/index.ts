import type { FastifyPluginAsync } from 'fastify';
import { PHARMACY_PERMISSIONS } from './permissions.js';
import { pharmacyRoutes } from './routes.js';

/**
 * Pharmacy: the queue of prescriptions to dispense, and dispensing their medication lines from
 * batches at a place, in full or in part, with generic substitution (#100). Behind the `pharmacy`
 * module flag. Moves medication orders through the clinical module's `moveMedicationOrder` and
 * stock through inventory's `stockOut`, never by writing their tables. Publishes
 * `pharmacy.dispensed`. Counter sales and the controlled drug register are #101, returns #104.
 */
export const pharmacyFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('pharmacy', PHARMACY_PERMISSIONS);
  await app.register(pharmacyRoutes);
};
