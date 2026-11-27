import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { dischargePlanRoutes } from './discharge-plan.js';
import { dischargeSummaryRoutes } from './discharge-summary.js';
import { ADMISSION_PERMISSIONS } from './permissions.js';
import { reservationRoutes } from './reservations.js';
import { admissionRoutes } from './routes.js';
import { admissionSettingsRoutes } from './settings.js';

/**
 * Admission, discharge and transfer (BE-23): admitting a patient with an inpatient encounter,
 * giving a bed and moving to another, discharge, the history of beds, the bed board with housekeeping
 * and a live stream of which ward changed. Behind the `admissions` module flag; the beds are the
 * `wards` module's. Publishes `admission.created`, `bed.assigned`, `bed.released` and
 * `discharge.completed` (and `encounter.opened` and `encounter.closed` for the stay).
 */
export const admissionsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('admissions', ADMISSION_PERMISSIONS);
  app.links.register('admission', 'admission_link_owner'); // migration 0158
  await app.register(admissionRoutes);
  await app.register(reservationRoutes);
  await app.register(dischargePlanRoutes);
  await app.register(dischargeSummaryRoutes);
  await app.register(admissionSettingsRoutes);
  app.visitHolds.register('admissions', hasAdmissionFrom);
};

/** For nursing (BE-24): the stay a ward record belongs to, within the caller's scope. */
export { admittedStays, stayInScope, type AdmittedStay, type Stay } from './stay.js';

/** For emergency (ER-02, #172): admitting a patient from the department. */
export { admitFromEmergency } from './from-emergency.js';

/** A visit that an admission not cancelled was raised from is not cancelled (#1214, #1223). */
async function hasAdmissionFrom(client: pg.ClientBase, encounterId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "select 1 from admissions where source_encounter_id = $1 and status <> 'cancelled' limit 1",
    [encounterId],
  );
  return (rowCount ?? 0) > 0;
}
