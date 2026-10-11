import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type pg from 'pg';
import { replayed } from '../idempotency/state.js';
import { WORKER_ROLE } from '../outbox/dispatcher.js';

/**
 * Creates the audit partitions for this month and the next three. Runs as the worker role: the
 * function is SECURITY DEFINER and only that role may call it, so the API's login needs no
 * ownership of the table.
 */
export async function ensureAuditPartitions(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    for (let ahead = 0; ahead <= 3; ahead++) {
      await client.query(
        "select ensure_audit_partition((date_trunc('month', now()) + make_interval(months => $1))::date)",
        [ahead],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** What a route declares so the audit hook records it. */
export interface AuditConfig {
  /** The kind of record touched, e.g. `patient`. */
  entity: string;
  /** Defaults from the method: GET `read`, POST `create`, PUT and PATCH `update`, DELETE `delete`. */
  action?: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Records every successful call to this route in the audit log. Set it on PHI routes. */
    audit?: AuditConfig;
  }
  interface FastifyRequest {
    /**
     * Adds an audit entry for something this request did (several records, or an action the
     * route config cannot express). Written in the request's transaction, only if it commits.
     */
    audit(action: string, entity: string, entityId?: string): void;
  }
}

interface Entry {
  action: string;
  entity: string;
  entityId: string | null;
}

const pending = new WeakMap<FastifyRequest, Entry[]>();

const METHOD_ACTIONS: Record<string, string> = {
  GET: 'read',
  HEAD: 'read',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/**
 * The audit log writer: who read or changed which record. Entries are inserted in the request's
 * transaction just before it commits, so they exist exactly when the change does. If the insert
 * fails the request fails (an unaudited PHI access is worse than an error).
 *
 * Must be registered BEFORE the tenancy plugin: Fastify runs `onSend` hooks in registration order
 * and the transaction commits in tenancy's, so this one has to run first.
 *
 * Audit rows hold ids and codes only, never field values.
 */
export const auditPlugin = fp(
  async (app) => {
    app.decorateRequest('audit', function (this: FastifyRequest, action, entity, entityId) {
      const entries = pending.get(this) ?? [];
      entries.push({ action, entity, entityId: entityId ?? null });
      pending.set(this, entries);
    });

    app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
      // A replayed result did not do the work again, so it is not a second access.
      if (reply.statusCode >= 400 || !request.tenant || replayed.has(request)) return;
      const entries = pending.get(request) ?? [];
      const declared = request.routeOptions.config.audit;
      if (declared) {
        const params = request.params as Record<string, unknown> | undefined;
        const id = typeof params?.id === 'string' ? params.id : null;
        entries.push({
          action: declared.action ?? METHOD_ACTIONS[request.method] ?? request.method.toLowerCase(),
          entity: declared.entity,
          entityId: id,
        });
      }
      pending.delete(request);
      for (const entry of entries) {
        // The hospital comes from the transaction's setting, never from a value the caller passes.
        await request.txClient.query(
          `insert into audit_log (tenant_id, actor_id, action, entity, entity_id, request_id)
           values (app_tenant_id(), $1, $2, $3, $4, $5)`,
          [request.session?.userId ?? null, entry.action, entry.entity, entry.entityId, request.id],
        );
      }
    });

    // A route that asks for auditing but has no tenant transaction could never write the row:
    // fail at startup instead of silently recording nothing.
    app.addHook('onRoute', (route) => {
      if (route.config?.audit && (route.config.access ?? 'tenant') !== 'tenant') {
        throw new Error(
          `${route.method.toString()} ${route.url} sets config.audit but is not a tenant route`,
        );
      }
    });

    // Months are created ahead of time so a row never lands in the default partition.
    app.jobs.work('audit.partitions', () => ensureAuditPartitions(app.database.pool));
    app.jobs.schedule('audit.partitions', '0 3 * * *');
  },
  { name: 'audit', dependencies: ['db', 'jobs', 'session'] },
);
