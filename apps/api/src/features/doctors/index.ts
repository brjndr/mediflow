import type { FastifyPluginAsync } from 'fastify';
import { DOCTOR_PERMISSIONS } from './permissions.js';
import { doctorRoutes } from './routes.js';

/**
 * Doctor profiles and their regular weekly working hours, which scheduling reads. Behind the
 * `doctors` module flag. A doctor is a member of staff in one of the hospital's departments, so
 * a hospital with this on has `departments` on too.
 */
export const doctorsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('doctors', DOCTOR_PERMISSIONS);
  await app.register(doctorRoutes);
};
