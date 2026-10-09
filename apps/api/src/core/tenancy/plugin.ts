import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type pg from 'pg';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { Tenant } from './routes.js';

/** The role every tenant request runs as. Created in migrations/0002. */
export const APP_ROLE = 'mediflow_app';
const TENANT_HEADER = 'x-tenant-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'fastify' {
  interface FastifyRequest {
    /** The active hospital. Set for routes with `access: 'tenant'` (the default). */
    tenant: { id: string } | null;
    /**
     * The request's transaction, already scoped to the active hospital. Every query a tenant
     * route makes goes through this, never through the pool.
     */
    tx: Database;
  }
}

interface RequestTransaction {
  client: pg.PoolClient;
  finished: boolean;
}

const transactions = new WeakMap<FastifyRequest, RequestTransaction>();

async function finish(request: FastifyRequest, outcome: 'commit' | 'rollback'): Promise<void> {
  const transaction = transactions.get(request);
  if (!transaction || transaction.finished) return;
  transaction.finished = true;
  try {
    await transaction.client.query(outcome);
    transaction.client.release();
  } catch (error) {
    // The connection is in an unknown state: destroy it instead of returning it to the pool.
    transaction.client.release(error instanceof Error ? error : true);
    if (outcome === 'commit') throw error;
  }
}

/**
 * Tenant isolation for every route that works with hospital data.
 *
 * Before the handler runs, the request gets a connection and a transaction in which:
 *   - the role is switched to the app role, which cannot bypass row-level security, and
 *   - `app.tenant_id` is set to the hospital from the server-side session.
 * Both are SET LOCAL, so they end with the transaction and can never leak to the next request
 * that uses the same pooled connection. Row-level security then filters every query.
 *
 * The tenant always comes from the session. `X-Tenant-ID` is only a consistency check: a request
 * whose header disagrees with the session (a stale tab after a hospital switch) is rejected.
 *
 * The transaction commits when the handler succeeds and rolls back when it fails, so a request
 * either does all of its work or none.
 */
export const tenancyPlugin = fp(
  async (app) => {
    // Registered app-wide: the session response carries the active hospital too.
    app.addSchema(Tenant);
    app.decorateRequest('tenant', null);
    // Accessing tx on a route without a tenant is a programming error, caught loudly.
    app.decorateRequest('tx', {
      getter(this: FastifyRequest): Database {
        throw new Error(
          `request.tx used on ${this.method} ${this.routeOptions.url}, which has no tenant transaction`,
        );
      },
    });

    app.addHook('preHandler', async (request) => {
      const access = request.routeOptions.config.access ?? 'tenant';
      if (access !== 'tenant' || request.is404) return;

      const tenantId = request.session?.tenantId;
      if (!tenantId) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');
      // The session is ours, but a malformed id must never reach SQL as a cast error.
      if (!UUID.test(tenantId)) throw new HttpError(409, 'no_active_tenant', 'Invalid tenant');

      const sent = request.headers[TENANT_HEADER];
      if (sent !== undefined && sent !== tenantId) {
        throw new HttpError(
          409,
          'tenant_mismatch',
          'X-Tenant-ID does not match the session tenant',
        );
      }

      const client = await app.database.pool.connect();
      transactions.set(request, { client, finished: false });
      await client.query('begin');
      await client.query(`set local role ${APP_ROLE}`);
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

      // Under row-level security this finds the session's hospital or nothing.
      const { rows } = await client.query<{ status: string }>('select status from tenants');
      const status = rows[0]?.status;
      if (status === undefined) {
        throw new HttpError(409, 'no_active_tenant', 'The hospital no longer exists');
      }
      if (status === 'suspended') {
        throw new HttpError(403, 'tenant_suspended', 'This hospital is suspended');
      }

      request.tenant = { id: tenantId };
      Object.defineProperty(request, 'tx', {
        value: drizzle(client, { schema }),
        configurable: true,
      });
    });

    // Commit before the response is sent, so a failed commit is reported as a failure.
    app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
      await finish(request, reply.statusCode < 400 ? 'commit' : 'rollback');
    });
    app.addHook('onError', async (request) => {
      await finish(request, 'rollback');
    });
    // The client went away mid-request: nothing it asked for should be kept.
    app.addHook('onRequestAbort', async (request) => {
      await finish(request, 'rollback');
    });
    // Last resort, so a connection can never be left checked out.
    app.addHook('onResponse', async (request) => {
      await finish(request, 'rollback');
    });
  },
  { name: 'tenancy', dependencies: ['db', 'session'] },
);
