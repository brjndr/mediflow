import type { FastifyPluginAsync } from 'fastify';
import { ADMISSION_PERMISSIONS } from './permissions.js';
import { admissionRoutes } from './routes.js';

/**
 * Admission, discharge and transfer (BE-23): admitting a patient with an inpatient encounter,
 * giving a bed and moving to another, discharge, the history of beds, the bed board with housekeeping
 * and a live stream of which ward changed. Behind the `admissions` module flag; the beds are the
 * `wards` module's. Publishes `admission.created`, `bed.assigned`, `bed.released` and
 * `discharge.completed` (and `encounter.opened` and `encounter.closed` for the stay).
 */
export const admissionsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('admissions', ADMISSION_PERMISSIONS);
  await app.register(admissionRoutes);
};
