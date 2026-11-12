import type { FastifyPluginAsync } from 'fastify';
import { HOSPITAL_PROFILE_PERMISSIONS } from './permissions.js';
import { hospitalProfileRoutes } from './routes.js';

/**
 * The hospital's letterhead details, edited by its admin. Always on, like roles and staff: the
 * details are printed by modules that each have their own switch.
 */
export const hospitalProfileFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('hospital-profile', HOSPITAL_PROFILE_PERMISSIONS);
  await app.register(hospitalProfileRoutes);
};
