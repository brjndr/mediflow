import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type pg from 'pg';
import { loadPolicy, type AccessPolicy } from '../access/policy.js';
import { NO_STORE } from '../http/cache.js';
import { HttpError } from '../http/errors.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
import { PgLiveBus, type LiveBus, type LiveData } from './bus.js';

/** A comment line this often keeps proxies from closing a quiet stream; the web app waits 45 s. */
export const KEEP_ALIVE_MS = 20_000;
/** How long the browser waits before opening a stream again after it breaks. */
export const RETRY_MS = 5_000;
/** Open streams one person may have at one hospital, on one API instance. */
export const MAX_STREAMS_PER_USER = 5;
/** How long a client may leave written events unread before its stream is ended. */
const STALLED_MS = 30_000;

export interface EventStreamOptions {
  /** The bus topic to follow, at the request's hospital. */
  topic: string;
  /** The SSE event name each message is sent as. */
  event: string;
  /**
   * Which messages this caller may be sent, or null to end the stream. Runs in a transaction of
   * the hospital under the app role: when the stream opens (the request's own), and again before
   * events are sent and at each keep-alive, once the session, the hospital, the route's module
   * and its permissions were found to still hold.
   */
  filter(
    client: pg.ClientBase,
    policy: AccessPolicy,
    userId: string,
  ): Promise<((data: LiveData) => boolean) | null>;
}

declare module 'fastify' {
  interface FastifyInstance {
    live: {
      bus: LiveBus;
      /**
       * Answers a tenant route with a server-sent event stream of a bus topic. The route's
       * guard has run; the request's transaction is committed before the stream starts, so an
       * open stream holds no database connection. Ends when the client goes, when the session
       * or the caller's access no longer holds, when the bus loses messages, and when the app
       * closes.
       */
      stream(
        request: FastifyRequest,
        reply: FastifyReply,
        options: EventStreamOptions,
      ): Promise<void>;
    };
  }
}

/**
 * Live updates: the bus that tells every API instance what changed, and event streams that pass it
 * on to the browser. Messages say which record changed, never what it holds; the screen reads it
 * again through its audited routes.
 */
export const livePlugin = fp<{ bus?: LiveBus }>(
  async (app, pluginOptions) => {
    const bus = pluginOptions.bus ?? new PgLiveBus(app.config.DATABASE_URL);
    /** How each open or starting stream is ended. */
    const open = new Set<() => void>();
    /** Open streams per hospital and person. */
    const streamsOf = new Map<string, number>();
    let closing = false;

    async function stream(
      request: FastifyRequest,
      reply: FastifyReply,
      options: EventStreamOptions,
    ) {
      const { session, tenant } = request;
      if (!session || !tenant) throw new HttpError(401, 'unauthenticated', 'No session');
      const { permissions = [], feature } = request.routeOptions.config;
      const tenantId = tenant.id;
      const userId = session.userId;

      const policy = await request.access.policy();
      let allow = policy ? await options.filter(request.txClient, policy, userId) : null;
      if (!allow) throw new HttpError(403, 'permission_denied', 'Nothing to follow');

      /** The session, the hospital and the route's access, all checked again. */
      const check = async () => {
        if (!(await app.auth.sessionStillHolds(session))) return null;
        return withTenantTransaction(app.database.pool, tenantId, async (client) => {
          const { rows } = await client.query<{ status: string }>('select status from tenants');
          if (rows[0]?.status !== 'active') return null;
          const now = await loadPolicy(client, tenantId, userId);
          if (!now) return null;
          if (feature !== undefined && now.features[feature] !== true) return null;
          const held = (permission: string) =>
            now.permissions.some((grant) => grant.permission === permission);
          if (!permissions.every(held)) return null;
          return options.filter(client, now, userId);
        });
      };

      const unavailable = () =>
        new HttpError(503, 'live_unavailable', 'Live updates are not available now');
      if (closing) throw unavailable();
      // A cap per person at the hospital, on this instance, so one session cannot hold the pool
      // with the checks of hundreds of streams.
      const who = `${tenantId}:${userId}`;
      const held = streamsOf.get(who) ?? 0;
      if (held >= MAX_STREAMS_PER_USER) {
        throw new HttpError(429, 'rate_limited', 'Too many open streams', {
          'retry-after': String(RETRY_MS / 1000),
        });
      }
      streamsOf.set(who, held + 1);

      let ended = false;
      // Nothing is written before the headers: a message may arrive while the request commits.
      let started = false;
      let checkedAt = Date.now();
      let stop: () => void = () => undefined;
      let keepAlive: NodeJS.Timeout | undefined = undefined;
      let stalled: NodeJS.Timeout | undefined = undefined;
      const pending: LiveData[] = [];
      let flushQueued = false;
      let work = Promise.resolve();

      const end = () => {
        if (ended) return;
        ended = true;
        open.delete(end);
        clearTimeout(keepAlive);
        clearTimeout(stalled);
        stop();
        const left = (streamsOf.get(who) ?? 1) - 1;
        if (left > 0) streamsOf.set(who, left);
        else streamsOf.delete(who);
        if (started && !reply.raw.writableEnded) reply.raw.end();
      };
      // Ended by the app closing and by the client going, from the start, not only once open.
      open.add(end);
      reply.raw.on('close', end);
      if (request.raw.socket.destroyed) end();

      const write = (text: string) => {
        if (!started || ended) return;
        // A client that stops reading is let go rather than buffered for without end.
        if (!reply.raw.write(text) && stalled === undefined) {
          stalled = setTimeout(end, STALLED_MS);
          reply.raw.once('drain', () => {
            clearTimeout(stalled);
            stalled = undefined;
          });
        }
      };
      // One step at a time, so checks never overlap and events keep their order.
      const serially = (step: () => Promise<void>) => {
        work = work.then(step).catch(() => {
          request.log.warn({ event: 'live_stream_check_failed' }, 'live stream check failed');
          end();
        });
      };
      const recheck = async () => {
        allow = await check();
        checkedAt = Date.now();
        if (!allow) end();
      };
      const flush = async () => {
        flushQueued = false;
        if (ended || pending.length === 0) return;
        const batch = [...new Map(pending.splice(0).map((data) => [JSON.stringify(data), data]))];
        if (Date.now() - checkedAt >= app.config.LIVE_RECHECK_MS) await recheck();
        for (const [text, data] of batch) {
          if (allow?.(data)) write(`event: ${options.event}\ndata: ${text}\n\n`);
        }
      };
      const queueFlush = () => {
        if (flushQueued || !started) return;
        flushQueued = true;
        serially(flush);
      };
      // The first keep-alive at a random point, so a hospital's streams do not all check at once.
      const keepAliveIn = (delay: number) => {
        keepAlive = setTimeout(() => {
          serially(async () => {
            await recheck();
            write(': keep-alive\n\n');
          });
          keepAliveIn(KEEP_ALIVE_MS);
        }, delay);
        keepAlive.unref();
      };

      try {
        stop = await bus.subscribe(tenantId, options.topic, {
          message(data) {
            if (ended) return;
            pending.push(data);
            queueFlush();
          },
          lost: end,
        });
      } catch {
        end();
        throw unavailable();
      }
      if (ended) throw unavailable();

      try {
        await request.commitNow();
      } catch (error) {
        end();
        throw error;
      }
      if (ended) throw unavailable();

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': NO_STORE,
        connection: 'keep-alive',
        // A proxy that buffers would hold events back.
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
      });
      started = true;
      write(`retry: ${RETRY_MS}\n\n`);
      keepAliveIn(KEEP_ALIVE_MS / 2 + Math.random() * (KEEP_ALIVE_MS / 2));
      // What arrived while the request committed.
      if (pending.length > 0) queueFlush();
    }

    app.decorate('live', { bus, stream });
    // Open and starting streams would keep the server from closing.
    app.addHook('preClose', async () => {
      closing = true;
      for (const end of [...open]) end();
    });
    app.addHook('onClose', async () => bus.close());
  },
  { name: 'live', dependencies: ['db', 'auth', 'tenancy', 'access'] },
);
