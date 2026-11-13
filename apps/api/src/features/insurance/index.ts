import type { FastifyPluginAsync } from 'fastify';
import { coverageRoutes } from './coverage.js';
import { mastersRoutes } from './masters.js';
import { INSURANCE_PERMISSIONS } from './permissions.js';
import { INSURANCE_SCHEMAS } from './schemas.js';

/**
 * Insurance (BE-28, #187), first slice behind the `insurance` switch: the payers (insurers, TPAs,
 * corporates) with their plans and rate agreements, a patient's policies and pre-authorizations.
 * Claims, split billing and corporate credit follow (`CLAUDE.md` in this folder).
 */
export const insuranceFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('insurance', INSURANCE_PERMISSIONS);
  for (const schema of INSURANCE_SCHEMAS) app.addSchema(schema);
  await app.register(mastersRoutes);
  await app.register(coverageRoutes);
};
