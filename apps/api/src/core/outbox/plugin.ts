import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { dispatchOutbox } from './dispatcher.js';
import { eventQueue, type DomainEvent, type DomainEventMessage } from './events.js';

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
      /** Runs `handler` for every `event`, in the job queue. Handlers must be idempotent. */
      subscribe(event: DomainEvent, handler: (message: DomainEventMessage) => Promise<void>): void;
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
      // The hospital comes from the transaction's setting, never from a value the caller passes.
      await this.txClient.query(
        `insert into outbox (tenant_id, event, entity_id, actor_id, payload)
         values (app_tenant_id(), $1, $2, $3, $4)`,
        [event, entityId, this.session?.userId ?? null, JSON.stringify(payload ?? {})],
      );
    });

    app.decorate('events', {
      subscribe: (event: DomainEvent, handler: (message: DomainEventMessage) => Promise<void>) =>
        app.jobs.work<DomainEventMessage>(eventQueue(event), handler),
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
