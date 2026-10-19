import type { FastifyPluginAsync } from 'fastify';
import { CODE_PERMISSIONS } from './permissions.js';
import { codeRoutes } from './routes.js';

/**
 * The diagnosis and procedure code sets, searched on the server, and each hospital's favourites
 * among them. A diagnosis and a procedure will be recorded by a code's id. Behind the `codes`
 * module flag. The sets themselves are loaded by an operator: see `load.ts`.
 */
export const codesFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('codes', CODE_PERMISSIONS);
  await app.register(codeRoutes);
};

/** For the clinical module: an ICD-10 code by id, to record a diagnosis with. */
export { diagnosisCode } from './repository.js';
