import type { FastifyPluginAsync } from 'fastify';
import { PATIENT_PERMISSIONS } from './permissions.js';
import { patientRoutes } from './routes.js';

/**
 * Patient registration and demographics. A patient is a record staff manage, never a user. Behind
 * the `patients` module flag, which a hospital has on or off.
 */
export const patientsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('patients', PATIENT_PERMISSIONS);
  await app.register(patientRoutes);
};
