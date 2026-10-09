import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ErrorBody, HttpError } from '../../core/http/errors.js';

const Health = Type.Object({ status: Type.Literal('ok') }, { $id: 'Health' });

/**
 * Every route declares its request and response schemas (validation, types and OpenAPI come from
 * the one definition) and an operationId, which names it in the generated client.
 */
export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Liveness: the process is up. Does not touch the database, so a slow database does not get
  // the container restarted.
  app.get(
    '/health',
    {
      schema: {
        operationId: 'getHealth',
        tags: ['system'],
        description: 'Liveness check. The process is running.',
        response: { 200: Health },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  // Readiness: the instance can serve requests. Used to decide whether to route traffic to it.
  app.get(
    '/health/ready',
    {
      schema: {
        operationId: 'getReadiness',
        tags: ['system'],
        description: 'Readiness check. The process can reach its database.',
        response: { 200: Health, 503: ErrorBody },
      },
    },
    async () => {
      if (!(await app.database.ping())) {
        throw new HttpError(503, 'database_unavailable', 'The database is not reachable');
      }
      return { status: 'ok' as const };
    },
  );
};
