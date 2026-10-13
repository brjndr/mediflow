import type { FastifyPluginAsync } from 'fastify';
import { DRUG_PERMISSIONS } from './permissions.js';
import { drugRoutes } from './routes.js';

/**
 * The drug and consumable master: what each item the hospital keeps is. Prescriptions, stock
 * and dispensing will refer to an item by id. Behind the `drugs` module flag.
 */
export const drugsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('drugs', DRUG_PERMISSIONS);
  await app.register(drugRoutes);
};
