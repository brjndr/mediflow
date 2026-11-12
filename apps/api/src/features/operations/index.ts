import type { FastifyPluginAsync } from 'fastify';
import { ambulanceRoutes } from './ambulance.js';
import { bloodBankRoutes } from './bloodbank.js';
import { BLOOD_EXPIRY_JOB, expireBloodUnitsEverywhere } from './expiry.js';
import { housekeepingRoutes, subscribeToReleasedBeds } from './housekeeping.js';
import { OPERATIONS_PERMISSIONS } from './permissions.js';
import { leaveRoutes } from './leave.js';
import { rosterRoutes } from './roster.js';
import { OPERATIONS_SCHEMAS } from './schemas.js';

/**
 * Hospital operations (BE-30, #200): duty rosters, the blood bank, ambulances and bed cleaning
 * tasks. Four hospital switches, one for each: `roster`, `bloodbank`, `ambulance` and
 * `housekeeping`. Publishes `roster.shift_scheduled`, `roster.shift_cancelled`,
 * `blood.unit_registered`, `blood.unit_status_changed`, `ambulance.trip_requested`,
 * `ambulance.trip_status_changed`, `cleaning.task_created` and `cleaning.task_completed`, and
 * subscribes to `bed.released` to make the cleaning task for the bed.
 */
export const operationsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('operations', OPERATIONS_PERMISSIONS);
  for (const schema of OPERATIONS_SCHEMAS) app.addSchema(schema);
  await app.register(rosterRoutes);
  await app.register(leaveRoutes);
  await app.register(bloodBankRoutes);
  await app.register(ambulanceRoutes);
  await app.register(housekeepingRoutes);
  subscribeToReleasedBeds(app);
  app.jobs.work(BLOOD_EXPIRY_JOB, () => expireBloodUnitsEverywhere(app.database.pool));
  app.jobs.schedule(BLOOD_EXPIRY_JOB, '*/15 * * * *');
};
