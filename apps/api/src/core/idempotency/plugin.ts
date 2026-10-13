import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type pg from 'pg';
import { HttpError } from '../http/errors.js';
import { WORKER_ROLE } from '../outbox/dispatcher.js';
import { claimed, replayed } from './state.js';

/** How a route opts in to idempotency (`config: { idempotent: ... }`). */
export interface IdempotentConfig {
  /**
   * What is kept of the first response to replay it:
   * - `'ids'` (the default): the status and the new record's `id` only. Use it for any route
   *   whose response contains patient data, so no PHI copy is kept.
   * - `'full'`: the whole response body, as it was sent. Only for routes that return no patient
   *   data.
   * - `'none'`: the status only. A repeat is not answered here: it reaches the handler with
   *   `request.replayOf` set to the first status, and the handler answers again with what is true
   *   now, doing no work. For a route whose response holds text that must not be kept a second
   *   time and has no single `id` (a whole ward, with the notes on its blocked beds).
   */
  body?: 'ids' | 'full' | 'none';
  /** Refuse a request that has no Idempotency-Key. Use it for payments. */
  required?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The status the first request with this Idempotency-Key was answered with, on a route that
     * keeps nothing else (`idempotent: { body: 'none' }`). Null for a request that is to do its
     * work. A handler of such a route checks it first and answers without doing the work again.
     */
    replayOf: number | null;
  }
  interface FastifyContextConfig {
    /** Makes a create or charge route accept an `Idempotency-Key` header. `true` means defaults. */
    idempotent?: true | IdempotentConfig;
  }
}

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const HEADER = 'idempotency-key';

const settings = (config: true | IdempotentConfig): IdempotentConfig =>
  config === true ? {} : config;

/** Deletes expired keys. Runs as the worker role, which is the only one that sees every hospital. */
export async function purgeExpiredKeys(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    await client.query('delete from idempotency_keys where expires_at <= now()');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The part of a request that decides whether a repeat is "the same request". */
function requestHash(request: {
  method: string;
  params: unknown;
  query: unknown;
  body: unknown;
  routeOptions: { url?: string };
}): string {
  const query = Object.entries((request.query ?? {}) as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.method,
        request.routeOptions.url,
        request.params,
        query,
        request.body ?? null,
      ]),
    )
    .digest('hex');
}

/** The response as it was sent, parsed, when it is JSON. Streams and other bodies are not kept. */
function sentJson(payload: unknown, contentType: unknown): unknown {
  if (typeof contentType !== 'string' || !contentType.includes('json')) return null;
  const text =
    typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString() : null;
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Saves the result of a request whose key was claimed. This is an `onSend` hook so it sees the
 * response exactly as the client gets it (after the route's response schema has removed what it
 * does not declare) for every kind of response, including an empty 204. It must be registered
 * BEFORE the tenancy plugin: tenancy commits in its own `onSend`, and the stored result has to be
 * saved with the work it describes.
 */
export const idempotencyStorePlugin = fp(
  async (app) => {
    app.addHook('onSend', async (request, reply, payload) => {
      const state = claimed.get(request);
      if (!state) return payload;
      claimed.delete(request);
      // A failure rolls the transaction back, key included, so the client can retry.
      if (reply.statusCode >= 400) return payload;

      const declared = request.routeOptions.config.idempotent;
      const keep = declared === undefined ? 'ids' : (settings(declared).body ?? 'ids');
      const sent = keep === 'none' ? null : sentJson(payload, reply.getHeader('content-type'));
      const id = (sent as { id?: unknown } | null)?.id;
      const stored = keep === 'full' ? sent : typeof id === 'string' ? { id } : null;

      await request.txClient.query(
        `update idempotency_keys set response_status = $1, response_body = $2
         where tenant_id = app_tenant_id() and user_id = $3 and key = $4`,
        [
          reply.statusCode,
          stored === null ? null : JSON.stringify(stored),
          state.userId,
          state.key,
        ],
      );
      return payload;
    });
  },
  { name: 'idempotency-store', dependencies: ['session'] },
);

/**
 * Repeating a create or charge request with the same `Idempotency-Key` returns the first result
 * instead of doing the work twice.
 *
 * The key is claimed inside the request's transaction, so a request that fails leaves nothing
 * behind and may be retried, and two requests with the same key at once are serialised by the
 * database: the second waits, then replays. A key is scoped to the hospital and the user. The same
 * key with a different request (method, path, query or body) is refused (422), never replayed.
 *
 * Register after the access plugin (it needs the tenant transaction and runs after the access
 * check, so a caller without permission learns nothing about stored keys). The matching
 * `idempotencyStorePlugin` goes before the tenancy plugin.
 */
export const idempotencyPlugin = fp(
  async (app) => {
    app.decorateRequest('replayOf', null);

    app.addHook('onRoute', (route) => {
      if (!route.config?.idempotent) return;
      if (route.method === 'GET' || route.method === 'HEAD') {
        throw new Error(`${route.url} sets config.idempotent on a read-only method`);
      }
      if ((route.config.access ?? 'tenant') !== 'tenant') {
        throw new Error(`${route.url} sets config.idempotent but is not a tenant route`);
      }
      // An audited route handles patient data. Keeping its whole response would make this table a
      // second copy of that data, so only the status and the id may be kept.
      const idempotent = route.config.idempotent;
      if (route.config.audit && typeof idempotent === 'object' && idempotent.body === 'full') {
        throw new Error(
          `${route.url} stores its whole response (idempotent.body 'full') but is audited, so it handles patient data`,
        );
      }
    });

    app.addHook('preHandler', async (request, reply) => {
      const declared = request.routeOptions.config.idempotent;
      if (!declared || request.is404) return;

      const header = request.headers[HEADER];
      if (header === undefined) {
        if (settings(declared).required) {
          throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key is required');
        }
        return;
      }
      if (typeof header !== 'string' || !KEY.test(header)) {
        throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key is not valid');
      }
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');

      const hash = requestHash(request);

      // A live key conflicts and returns nothing; an expired one is reclaimed.
      const claim = await request.txClient.query(
        `insert into idempotency_keys (tenant_id, user_id, key, request_hash, expires_at)
         values (app_tenant_id(), $1, $2, $3, now() + make_interval(hours => $4))
         on conflict (tenant_id, user_id, key) do update
           set request_hash = excluded.request_hash, response_status = null, response_body = null,
               created_at = now(), expires_at = excluded.expires_at
           where idempotency_keys.expires_at <= now()
         returning 1`,
        [userId, header, hash, app.config.IDEMPOTENCY_TTL_HOURS],
      );
      if (claim.rowCount === 1) {
        claimed.set(request, { key: header, userId });
        return;
      }

      const { rows } = await request.txClient.query<{
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
      }>(
        `select request_hash, response_status, response_body from idempotency_keys
         where tenant_id = app_tenant_id() and user_id = $1 and key = $2`,
        [userId, header],
      );
      const stored = rows[0];
      if (!stored) throw new HttpError(409, 'idempotency_conflict', 'Try the request again');
      if (stored.request_hash !== hash) {
        throw new HttpError(
          422,
          'idempotency_key_reuse',
          'This Idempotency-Key was used for a different request',
        );
      }
      if (stored.response_status === null) {
        throw new HttpError(
          409,
          'idempotency_unfinished',
          'The first request has no stored result',
        );
      }

      replayed.add(request);
      if (settings(declared).body === 'none') {
        // Nothing was kept to answer with: the handler answers again, and does no work.
        request.replayOf = stored.response_status;
        void reply.header('idempotent-replayed', 'true');
        return;
      }
      void reply.status(stored.response_status).header('idempotent-replayed', 'true');
      if (stored.response_status === 204) return reply.send();
      // A string payload skips the route's response serializer, so a reduced body is not rejected
      // for missing fields.
      return reply
        .type('application/json; charset=utf-8')
        .send(JSON.stringify(stored.response_body ?? {}));
    });

    app.jobs.work('idempotency.purge', () => purgeExpiredKeys(app.database.pool));
    app.jobs.schedule('idempotency.purge', '30 3 * * *');
  },
  { name: 'idempotency', dependencies: ['tenancy', 'access', 'jobs'] },
);
