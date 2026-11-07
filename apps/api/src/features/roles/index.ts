import type { FastifyPluginAsync } from 'fastify';
import { ROLE_PERMISSIONS } from './permissions.js';
import { roleRoutes } from './routes.js';

/** A hospital's roles and what they may do. Always on, like staff: access cannot be run without it. */
export const rolesFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('roles', ROLE_PERMISSIONS);
  await app.register(roleRoutes);
};
