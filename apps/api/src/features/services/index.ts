import type { FastifyPluginAsync } from 'fastify';
import { serviceImport } from './create.js';
import { SERVICE_PERMISSIONS } from './permissions.js';
import { serviceRoutes } from './routes.js';

/**
 * The price catalog: what the hospital charges for and what each costs from a date. Lab tests,
 * bed categories and, later, orders and charges refer to a service by id. Behind the `services`
 * module flag. Services can also be loaded from a file through the import centre.
 */
export const servicesFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('services', SERVICE_PERMISSIONS);
  app.importKinds.register(serviceImport);
  await app.register(serviceRoutes);
};

/** For the clinical module: a service of a category that may be ordered (imaging, procedure). */
export { orderableService } from './repository.js';
