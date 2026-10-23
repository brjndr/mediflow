import { randomUUID } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { auditPlugin } from './core/audit/plugin.js';
import { authPlugin } from './core/auth/plugin.js';
import { accessPlugin } from './core/access/plugin.js';
import { accessRoutes } from './core/access/routes.js';
import { accountRoutes } from './core/auth/account-routes.js';
import { staffEmailsPlugin } from './core/auth/emails.js';
import { authRoutes } from './core/auth/routes.js';
import type { Config } from './core/config/config.js';
import { dbPlugin } from './core/db/plugin.js';
import { NO_STORE, registerCacheDefault } from './core/http/cache.js';
import { registerErrorHandling } from './core/http/errors.js';
import { registerStrictBodies } from './core/http/strict-body.js';
import { jobsPlugin } from './core/jobs/plugin.js';
import type { JobQueue } from './core/jobs/queue.js';
import { loggerOptions } from './core/logging/logger.js';
import { openApiPlugin } from './core/openapi/plugin.js';
import type { Notifier } from './core/notifier/notifier.js';
import { notifierPlugin } from './core/notifier/plugin.js';
import { outboxPlugin } from './core/outbox/plugin.js';
import { idempotencyPlugin, idempotencyStorePlugin } from './core/idempotency/plugin.js';
import { importKindsPlugin } from './core/imports/registry.js';
import type { LiveBus } from './core/live/bus.js';
import { livePlugin } from './core/live/plugin.js';
import type { RateLimiter } from './core/ratelimit/limiter.js';
import { rateLimitPlugin } from './core/ratelimit/plugin.js';
import { sessionPlugin, type SessionResolver } from './core/session/plugin.js';
import { tenancyPlugin } from './core/tenancy/plugin.js';
import { tenantRoutes } from './core/tenancy/routes.js';
import { healthFeature } from './features/health/index.js';
import { appointmentsFeature } from './features/appointments/index.js';
import { queueFeature } from './features/queue/index.js';
import { triageFeature } from './features/triage/index.js';
import { clinicalFeature } from './features/clinical/index.js';
import { codesFeature } from './features/codes/index.js';
import { departmentsFeature } from './features/departments/index.js';
import { doctorsFeature } from './features/doctors/index.js';
import { drugsFeature } from './features/drugs/index.js';
import { importsFeature } from './features/imports/index.js';
import { labFeature } from './features/lab/index.js';
import { labTestsFeature } from './features/lab-tests/index.js';
import { patientsFeature } from './features/patients/index.js';
import { servicesFeature } from './features/services/index.js';
import { templatesFeature } from './features/templates/index.js';
import { staffFeature } from './features/staff/index.js';
import { wardsFeature } from './features/wards/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export interface AppOptions {
  /**
   * How a request becomes a session. Defaults to the session cookie (core/auth). Tests that are
   * not about authentication pass their own.
   */
  resolveSession?: SessionResolver;
  /** How staff email is sent. Defaults to SMTP. Tests pass an in-memory notifier. */
  notifier?: Notifier;
  /** The job queue. Defaults to pg-boss, or an in-process queue when `JOBS_ENABLED` is off. */
  jobQueue?: JobQueue;
  /** Request counters for the per-hospital and per-user limits. Defaults to in-process. */
  rateLimiter?: RateLimiter;
  /** What tells open screens that something changed. Defaults to Postgres LISTEN/NOTIFY. */
  liveBus?: LiveBus;
}

/**
 * Builds the API without starting it, so tests can drive it in-process. Core plugins are
 * registered first, then one line per feature.
 *
 * Every request passes through the core hooks in this order: session (who is asking), tenancy
 * (a transaction scoped to their hospital), access (may they do this there). A route is closed unless it says otherwise: the
 * default `access` is `tenant`.
 */
export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config),
    // Ids are generated here and never taken from the client, so a log line cannot be forged.
    genReqId: () => randomUUID(),
    // Stop reading a request body past this size (1 MiB). File uploads go to object storage.
    bodyLimit: 1_048_576,
    // Behind a load balancer the client address comes from the forwarded header.
    trustProxy: config.TRUST_PROXY,
    // An address the router cannot read is refused before any hook runs, so the answer is made
    // here: the standard body, which does not repeat the address, and not to be stored.
    frameworkErrors: (_error, request, reply) => {
      void (reply as FastifyReply)
        .status(400)
        .header('cache-control', NO_STORE)
        .header('x-request-id', request.id)
        .send({
          error: {
            code: 'bad_request',
            message: 'The request could not be processed',
            requestId: request.id,
          },
        });
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);
  registerErrorHandling(app);
  // No answer is kept by a browser or a cache unless its route says otherwise.
  registerCacheDefault(app);
  // Before any route: a JSON body is checked for the types it was sent with.
  registerStrictBodies(app);

  // Core. OpenAPI comes first: it has to see every route as it is registered.
  await app.register(openApiPlugin);
  await app.register(dbPlugin);
  await app.register(jobsPlugin, { queue: options.jobQueue });
  await app.register(notifierPlugin, { notifier: options.notifier });
  await app.register(authPlugin);
  await app.register(staffEmailsPlugin);
  await app.register(sessionPlugin, { resolveSession: options.resolveSession });
  // Right after the session and before any database work, so a refused request costs nothing.
  await app.register(rateLimitPlugin, { limiter: options.rateLimiter });
  // Audit before tenancy: its onSend writes the audit rows before tenancy commits (core/audit).
  await app.register(auditPlugin);
  // Same reason: it saves the idempotent result in onSend, before tenancy commits.
  await app.register(idempotencyStorePlugin);
  await app.register(tenancyPlugin);
  await app.register(outboxPlugin);
  await app.register(accessPlugin);
  await app.register(idempotencyPlugin);
  await app.register(livePlugin, { bus: options.liveBus });
  await app.register(tenantRoutes);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(accessRoutes);
  // Before the features: each one that can be loaded from a file registers its kind here.
  await app.register(importKindsPlugin);

  // Features: one line each.
  await app.register(healthFeature);
  await app.register(staffFeature);
  await app.register(patientsFeature);
  await app.register(departmentsFeature);
  await app.register(doctorsFeature);
  await app.register(servicesFeature);
  await app.register(drugsFeature);
  await app.register(labTestsFeature);
  await app.register(wardsFeature);
  await app.register(codesFeature);
  await app.register(templatesFeature);
  await app.register(importsFeature);
  await app.register(appointmentsFeature);
  await app.register(queueFeature);
  await app.register(triageFeature);
  await app.register(clinicalFeature);
  await app.register(labFeature);

  return app;
}
