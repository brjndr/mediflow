import type { FastifyPluginAsync } from 'fastify';
import { LAB_TEST_PERMISSIONS } from './permissions.js';
import { labTestRoutes } from './routes.js';

/**
 * The lab test catalog: the tests and panels the laboratory offers, and the reference ranges a
 * numeric result is read against. Orders and results will refer to a test by id. Behind the
 * `lab_tests` module flag. A test is charged as a service of the price catalog (`services`).
 */
export const labTestsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('lab_tests', LAB_TEST_PERMISSIONS);
  await app.register(labTestRoutes);
};
