import type { FastifyPluginAsync } from 'fastify';
import { WARD_PERMISSIONS } from './permissions.js';
import { wardRoutes } from './routes.js';

/**
 * The wards of the hospital, their rooms and beds, and the bed categories that decide what a day
 * in a bed is charged as. Admissions will refer to a bed by id, and set it occupied and being
 * cleaned. Behind the `wards` module flag. A category is charged as a bed-day service of the
 * price catalog (`services`), and a ward may belong to a department (`departments`).
 */
export const wardsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('wards', WARD_PERMISSIONS);
  await app.register(wardRoutes);
};
