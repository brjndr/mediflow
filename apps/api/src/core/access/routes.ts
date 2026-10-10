import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../http/errors.js';
import { errors, ref } from '../http/schemas.js';
import { AccessPolicy } from './policy.js';

export const accessRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/session/policy',
    {
      // Any member may read their own policy.
      config: { permissions: [] },
      schema: {
        operationId: 'getSessionPolicy',
        tags: ['auth'],
        description:
          'The effective access policy for the active tenant. Supports ETag and If-None-Match so a refresh is cheap. Returns 409 tenant_mismatch when X-Tenant-ID differs from the session tenant.',
        headers: Type.Object({ 'If-None-Match': Type.Optional(Type.String()) }),
        response: {
          200: {
            ...ref(AccessPolicy),
            description: 'The current policy',
            headers: { ETag: { schema: { type: 'string' } } },
          },
          304: Type.Null({ description: 'The policy has not changed' }),
          ...errors(401, 403, 409),
        },
      },
    },
    async (request, reply) => {
      const policy = await request.access.policy();
      // The session resolver has already checked membership, so this is a race with a removal.
      if (!policy) throw new HttpError(403, 'permission_denied', 'Not a member of this hospital');

      const etag = `"${policy.version}"`;
      // Private to the user and revalidated every time: cheap, and never stale after a change.
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) {
        // A 304 has no body at all, which the typed reply has no way to say.
        return reply.status(304).send(undefined as unknown as null);
      }
      return policy;
    },
  );
};
