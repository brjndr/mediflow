import type { FastifyPluginAsync } from 'fastify';
import { SERVICE_PERMISSIONS } from './permissions.js';
import { serviceRoutes } from './routes.js';

/**
 * The price catalog: what the hospital charges for and what each costs from a date. Lab tests,
 * bed categories and, later, orders and charges refer to a service by id. Behind the `services`
 * module flag.
 */
export const servicesFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('services', SERVICE_PERMISSIONS);
  await app.register(serviceRoutes);
};
