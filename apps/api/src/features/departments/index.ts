import type { FastifyPluginAsync } from 'fastify';
import { DEPARTMENT_PERMISSIONS } from './permissions.js';
import { departmentRoutes } from './routes.js';

/**
 * The hospital's own list of departments, which doctors and, later, appointments and encounters
 * refer to by id. Behind the `departments` module flag.
 */
export const departmentsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('departments', DEPARTMENT_PERMISSIONS);
  await app.register(departmentRoutes);
};
