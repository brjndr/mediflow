import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';

const Health = Type.Object({ status: Type.Literal('ok') }, { $id: 'Health' });

/**
 * Every route declares its request and response schemas (validation, types and OpenAPI come from
 * the one definition) and an operationId, which names it in the generated client.
 */
export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Registered so it gets a name in the contract: the web app imports the `Health` type.
  app.addSchema(Health);

  // Liveness: the process is up. Does not touch the database, so a slow database does not get
  // the container restarted.
  app.get(
    '/health',
    {
      config: { access: 'public' },
      schema: {
        operationId: 'getHealth',
        tags: ['system'],
        description: 'Liveness check. The process is running.',
        response: { 200: ref(Health) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  // Readiness: the instance can serve requests. Used to decide whether to route traffic to it.
  app.get(
    '/health/ready',
    {
      config: { access: 'public' },
      schema: {
        operationId: 'getReadiness',
        tags: ['system'],
        description: 'Readiness check. The process can reach its database.',
        response: { 200: ref(Health), ...errors(503) },
      },
    },
    async () => {
      if (!(await app.database.ping())) {
        throw new HttpError(503, 'database_unavailable', 'The database is not reachable');
      }
      return { status: 'ok' as const };
    },
  );

  // Scanner health (#1064): for a monitor, not a load balancer, so an engine outage never takes
  // an API instance out of rotation. 503 when clamd does not answer or its signatures are older
  // than CLAMAV_MAX_SIGNATURE_AGE_HOURS (freshclam stopped). Public and free of patient data.
  app.get(
    '/health/scanner',
    {
      config: { access: 'public' },
      schema: {
        operationId: 'getScannerHealth',
        tags: ['system'],
        description: 'Malware scanner check. The engine answers and its signatures are recent.',
        response: { 200: ref(Health), ...errors(503) },
      },
    },
    async () => {
      const health = await app.scanner.health?.();
      if (!health) return { status: 'ok' as const };
      if (!health.reachable) {
        throw new HttpError(503, 'scanner_unavailable', 'The malware scanner is not reachable');
      }
      const maxAgeMs = app.config.CLAMAV_MAX_SIGNATURE_AGE_HOURS * 3_600_000;
      if (!health.signaturesBuiltAt || Date.now() - health.signaturesBuiltAt.getTime() > maxAgeMs) {
        throw new HttpError(
          503,
          'scanner_signatures_stale',
          'The scanner signatures are out of date',
        );
      }
      return { status: 'ok' as const };
    },
  );
};
