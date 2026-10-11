import type pg from 'pg';
import type { JobQueue } from '../jobs/queue.js';
import { eventQueue, type DomainEvent, type DomainEventMessage } from './events.js';

/** The role the dispatcher runs as. Created in migrations/0007. */
export const WORKER_ROLE = 'mediflow_worker';
/** Failed hand-offs after which an event is left alone (and shows up in monitoring). */
export const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string;
  tenant_id: string;
  event: DomainEvent;
  entity_id: string | null;
  actor_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

/**
 * Hands pending outbox events to the job queue and marks them dispatched; returns how many went.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several API instances can dispatch at once.
 * Each row is sent and marked on its own: one the queue refuses gets its `attempts` counted and
 * does not hold back the rest, and after MAX_ATTEMPTS it is no longer picked up. The job id is the
 * outbox id, so if the process dies between queueing and the commit the repeat is dropped by the
 * queue; subscribers must still be idempotent (`eventId` identifies the event).
 */
export async function dispatchOutbox(
  pool: pg.Pool,
  queue: JobQueue,
  batchSize = 100,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const { rows } = await client.query<OutboxRow>(
      `select id, tenant_id, event, entity_id, actor_id, payload, occurred_at
       from outbox
       where dispatched_at is null and attempts < $2
       order by occurred_at, id
       limit $1
       for update skip locked`,
      [batchSize, MAX_ATTEMPTS],
    );
    let dispatched = 0;
    for (const row of rows) {
      const message: DomainEventMessage = {
        eventId: row.id,
        tenantId: row.tenant_id,
        event: row.event,
        entityId: row.entity_id,
        actorId: row.actor_id,
        occurredAt: row.occurred_at.toISOString(),
        payload: row.payload,
      };
      try {
        await queue.send(eventQueue(row.event), message, { id: row.id });
        await client.query('update outbox set dispatched_at = now() where id = $1', [row.id]);
        dispatched++;
      } catch {
        await client.query('update outbox set attempts = attempts + 1 where id = $1', [row.id]);
      }
    }
    await client.query('commit');
    return dispatched;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
