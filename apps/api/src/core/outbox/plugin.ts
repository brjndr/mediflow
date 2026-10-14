import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type pg from 'pg';
import type { Database } from '../db/client.js';
import { dispatchOutbox } from './dispatcher.js';
import { eventQueue, type DomainEvent, type DomainEventMessage } from './events.js';
import { runAsTenant } from './subscribe.js';

type EventHandler = (message: DomainEventMessage, tx: Database) => Promise<void>;

/**
 * Writes an event to the outbox in the transaction of `client`, at its hospital. A request does
 * it through `request.emit`; background work that writes records (the import centre) calls this.
 */
export async function insertEvent(
  client: Pick<pg.ClientBase, 'query'>,
  event: DomainEvent,
  entityId: string,
  actorId: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  // The hospital comes from the transaction's setting, never from a value the caller passes.
  await client.query(
    `insert into outbox (tenant_id, event, entity_id, actor_id, payload)
     values (app_tenant_id(), $1, $2, $3, $4)`,
    [event, entityId, actorId, JSON.stringify(payload)],
  );
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Publishes a domain event. It is written in the request's transaction, so it exists only if
     * the request commits: a rolled-back request emits nothing. Pass ids and codes in `payload`,
     * never patient data.
     */
    emit(event: DomainEvent, entityId: string, payload?: Record<string, unknown>): Promise<void>;
  }
  interface FastifyInstance {
    events: {
      /**
       * Runs `handler` for every `event`, in the job queue. The handler gets a transaction bound
       * to the event's hospital (row-level security applies, as in a request) and must be
       * idempotent.
       */
      subscribe(event: DomainEvent, handler: EventHandler): void;
      /** Moves pending events to the queue now. The poller calls this; tests may too. */
      dispatch(): Promise<number>;
    };
  }
}

/**
 * The transactional outbox. `request.emit` records the event with the change; a poller hands
 * pending events to the job queue, where subscribers pick them up.
 */
export const outboxPlugin = fp(
  async (app) => {
    app.decorateRequest('emit', async function (this: FastifyRequest, event, entityId, payload) {
      await insertEvent(this.txClient, event, entityId, this.session?.userId ?? null, payload);
    });

    app.decorate('events', {
      subscribe: (event: DomainEvent, handler: EventHandler) =>
        app.jobs.work<DomainEventMessage>(eventQueue(event), (message) =>
          runAsTenant(app.database.pool, message, handler),
        ),
      dispatch: () => dispatchOutbox(app.database.pool, app.jobs),
    });

    if (!app.config.JOBS_ENABLED) return;

    let timer: NodeJS.Timeout | undefined;
    let running = false;
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        app.events
          .dispatch()
          .catch(() => {
            app.log.warn({ event: 'outbox_dispatch_failed' }, 'outbox dispatch failed');
          })
          .finally(() => {
            running = false;
          });
      }, app.config.OUTBOX_POLL_MS);
      timer.unref();
    });
    app.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'outbox', dependencies: ['db', 'jobs', 'tenancy'] },
);
