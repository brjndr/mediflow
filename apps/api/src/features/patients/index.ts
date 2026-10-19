import type { FastifyPluginAsync } from 'fastify';
import { patientImport } from './create.js';
import { PATIENT_PERMISSIONS } from './permissions.js';
import { patientRoutes } from './routes.js';

/**
 * Patient registration and demographics. A patient is a record staff manage, never a user. Behind
 * the `patients` module flag, which a hospital has on or off. Patients can also be registered in
 * bulk from a file through the import centre, with `patient:import`.
 */
export const patientsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('patients', PATIENT_PERMISSIONS);
  app.importKinds.register(patientImport);
  await app.register(patientRoutes);
};

/** For another module that answers about a patient: is it within the caller's scope here. */
export { patientInScope } from './repository.js';
