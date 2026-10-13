import type { FastifyPluginAsync } from 'fastify';
import { TEMPLATE_PERMISSIONS } from './permissions.js';
import { templateRoutes } from './routes.js';

/**
 * Document templates: each hospital's own texts for a prescription, a clinical note, a consent
 * form and a discharge summary, with placeholders and versions that are never changed. A document
 * will record the version of the template it was made from. Behind the `templates` module flag.
 */
export const templatesFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('templates', TEMPLATE_PERMISSIONS);
  await app.register(templateRoutes);
};
