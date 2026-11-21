import type { FastifyPluginAsync } from 'fastify';
import { AUDIT_PERMISSIONS } from './permissions.js';
import { auditRoutes } from './routes.js';

/**
 * The hospital's own audit log (#1066): a search for its admin, behind the `audit_log` switch.
 * The export is the `audit_log` report of the reports module.
 */
export const auditFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('audit', AUDIT_PERMISSIONS);
  await app.register(auditRoutes);
};
