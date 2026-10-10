import swagger from '@fastify/swagger';
import fp from 'fastify-plugin';
import { SHARED_SCHEMAS } from '../http/schemas.js';

/**
 * Version of the API contract. Raise it in the same PR as a breaking change (a removed path,
 * operation, response, schema or property, or a changed type). CI compares the contract with the
 * base branch and fails on a breaking change that leaves this unchanged. While the major version
 * is 0, a breaking change bumps the minor.
 */
export const CONTRACT_VERSION = '0.1.0';

/**
 * Builds the OpenAPI document from the route schemas. Must be registered before any route.
 * The document is not served over HTTP: `pnpm gen:api` writes it to packages/contract, where the
 * web app's types are generated from it.
 */
export const openApiPlugin = fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Mediflow API',
          version: CONTRACT_VERSION,
          description:
            'Generated from the API route schemas by `pnpm gen:api`. Do not edit by hand.',
        },
        tags: [
          { name: 'system', description: 'Health and readiness' },
          { name: 'tenancy', description: 'The active hospital and its configuration' },
          { name: 'auth', description: 'Sign-in and the session' },
          { name: 'staff', description: 'Who works at the hospital' },
        ],
      },
      // Name components after the schema's $id instead of def-0, def-1, ...
      refResolver: {
        buildLocalReference: (json, _baseUri, _fragment, index) =>
          typeof json.$id === 'string' ? json.$id : `def-${index}`,
      },
    });
    for (const schema of SHARED_SCHEMAS) app.addSchema(schema);
  },
  { name: 'openapi' },
);
