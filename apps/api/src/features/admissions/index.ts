import type { FastifyPluginAsync } from 'fastify';
import { dischargePlanRoutes } from './discharge-plan.js';
import { dischargeSummaryRoutes } from './discharge-summary.js';
import { ADMISSION_PERMISSIONS } from './permissions.js';
import { reservationRoutes } from './reservations.js';
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
  await app.register(reservationRoutes);
  await app.register(dischargePlanRoutes);
  await app.register(dischargeSummaryRoutes);
};

/** For nursing (BE-24): the stay a ward record belongs to, within the caller's scope. */
export { admittedStays, stayInScope, type AdmittedStay, type Stay } from './stay.js';

/** For emergency (ER-02, #172): admitting a patient from the department. */
export { admitFromEmergency } from './from-emergency.js';
