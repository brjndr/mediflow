import type { FastifyPluginAsync } from 'fastify';
import { labTestImport } from './create.js';
import { LAB_TEST_PERMISSIONS } from './permissions.js';
import { labTestRoutes } from './routes.js';

/**
 * The lab test catalog: the tests and panels the laboratory offers, and the reference ranges a
 * numeric result is read against. Orders and results will refer to a test by id. Behind the
 * `lab_tests` module flag. A test is charged as a service of the price catalog (`services`).
 * Single tests can also be loaded from a file through the import centre.
 */
export const labTestsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('lab_tests', LAB_TEST_PERMISSIONS);
  app.importKinds.register(labTestImport);
  await app.register(labTestRoutes);
};
