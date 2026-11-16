import type { FastifyPluginAsync } from 'fastify';
import { ambulanceRoutes } from './ambulance.js';
import { bloodBankRoutes } from './bloodbank.js';
import { bloodDonorRoutes } from './blooddonors.js';
import { bloodReactionRoutes } from './bloodreactions.js';
import { bloodRecallRoutes } from './bloodrecalls.js';
import { bloodTestingRoutes } from './bloodtesting.js';
import { BLOOD_EXPIRY_JOB, expireBloodUnitsEverywhere } from './expiry.js';
import { housekeepingRoutes, subscribeToReleasedBeds } from './housekeeping.js';
import { OPERATIONS_PERMISSIONS } from './permissions.js';
import { leaveRoutes } from './leave.js';
import { rosterRoutes } from './roster.js';
import { rosterPlanRoutes } from './rosterplan.js';
import { OPERATIONS_SCHEMAS, RECALL_SCHEMAS } from './schemas.js';

/**
 * Hospital operations (BE-30, #200): duty rosters, the blood bank, ambulances and bed cleaning
 * tasks. Four hospital switches, one for each: `roster`, `bloodbank`, `ambulance` and
 * `housekeeping`. Publishes `roster.shift_scheduled`, `roster.shift_cancelled`,
 * `blood.unit_registered`, `blood.unit_status_changed`, `blood.donor_registered`,
 * `blood.donor_deferred`, `blood.collection_recorded`, `blood.unit_screened`,
 * `blood.crossmatch_recorded`, `blood.reaction_recorded`, `blood.unit_recalled`, `ambulance.trip_requested`,
 * `ambulance.trip_status_changed`, `cleaning.task_created` and `cleaning.task_completed`, and
 * subscribes to `bed.released` to make the cleaning task for the bed.
 */
export const operationsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('operations', OPERATIONS_PERMISSIONS);
  for (const schema of [...OPERATIONS_SCHEMAS, ...RECALL_SCHEMAS]) app.addSchema(schema);
  await app.register(rosterRoutes);
  await app.register(rosterPlanRoutes);
  await app.register(leaveRoutes);
  await app.register(bloodBankRoutes);
  await app.register(bloodDonorRoutes);
  await app.register(bloodTestingRoutes);
  await app.register(bloodReactionRoutes);
  await app.register(bloodRecallRoutes);
  await app.register(ambulanceRoutes);
  await app.register(housekeepingRoutes);
  subscribeToReleasedBeds(app);
  app.jobs.work(BLOOD_EXPIRY_JOB, () => expireBloodUnitsEverywhere(app.database.pool));
  app.jobs.schedule(BLOOD_EXPIRY_JOB, '*/15 * * * *');
};
