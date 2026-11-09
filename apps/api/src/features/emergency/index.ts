import type { FastifyPluginAsync } from 'fastify';
import { EMERGENCY_PERMISSIONS } from './permissions.js';
import { emergencyRoutes } from './routes.js';
import { EMERGENCY_SCHEMAS } from './schemas.js';

/**
 * Emergency (BE-26, #175): arrivals registered in a few fields, an unidentified patient under a
 * temporary ID, triage categories, linking a case to a patient on record later (undone within a
 * window) and the department's board. Behind the `emergency` flag; a patient on record needs the
 * `patients` flag. Publishes `er.registered`, `er.triaged`, `er.identified` and `er.unidentified`.
 */
export const emergencyFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('emergency', EMERGENCY_PERMISSIONS);
  for (const schema of EMERGENCY_SCHEMAS) app.addSchema(schema);
  await app.register(emergencyRoutes);
};
