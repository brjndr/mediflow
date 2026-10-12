import type { FastifyPluginAsync } from 'fastify';
import { memberRoutes } from './members.js';
import { STAFF_PERMISSIONS } from './permissions.js';
import { staffRoutes } from './routes.js';

/** Who works at the hospital. Always on: a hospital cannot run without managing its staff. */
export const staffFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('staff', STAFF_PERMISSIONS);
  await app.register(staffRoutes);
  await app.register(memberRoutes);
};
