import type { FastifyPluginAsync } from 'fastify';
import { WARD_PERMISSIONS } from './permissions.js';
import { wardRoutes } from './routes.js';

/**
 * The wards of the hospital, their rooms and beds, and the bed categories that decide what a day
 * in a bed is charged as. Admissions refer to a bed by id, and set it occupied and being
 * cleaned. Behind the `wards` module flag. A category is charged as a bed-day service of the
 * price catalog (`services`), and a ward may belong to a department (`departments`).
 */
export const wardsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('wards', WARD_PERMISSIONS);
  await app.register(wardRoutes);
};

/**
 * For admissions (BE-23): changing a bed's status takes the ward's lock first (`lockWard`), then
 * moves the bed from the status it is in (`moveBed`, false when it is no longer in it).
 */
export { bedForAdmission, lockWard, moveBed, type AdmissionBed } from './repository.js';
export type { BedStatus } from './schemas.js';

export { BEDS_TOPIC } from './topic.js';
