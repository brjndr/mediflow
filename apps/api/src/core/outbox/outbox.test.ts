import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asTenantSql,
  buildTestApp,
  createTenant,
  deleteTenants,
  resolveTestSession,
  type TestTenant,
} from '../../../test/helpers.js';
import { MemoryQueue, type SendOptions } from '../jobs/queue.js';
import { MAX_ATTEMPTS, WORKER_ROLE } from './dispatcher.js';
import type { DomainEventMessage } from './events.js';

/** A queue that refuses events about one chosen entity. */
class FlakyQueue extends MemoryQueue {
  refuse: string | null = null;
  override async send(name: string, data: object, options: SendOptions = {}): Promise<void> {
    if (this.refuse !== null && (data as DomainEventMessage).entityId === this.refuse) {
      throw new Error('queue unavailable');
    }
    await super.send(name, data, options);
  }
}

let app: FastifyInstance;
let pool: pg.Pool;
let queue: FlakyQueue;
let hospital: TestTenant;
let clinic: TestTenant;
const received: DomainEventMessage[] = [];

beforeAll(async () => {
  queue = new FlakyQueue();
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    jobQueue: queue,
    extend(instance) {
      instance.post<{ Body: { entityId: string; fail?: boolean } }>(
        '/patients',
        { config: { permissions: [] } },
        async (request) => {
          await request.emit('patient.registered', request.body.entityId, { source: 'test' });
          if (request.body.fail) throw new Error('failed after emitting');
          return { ok: true };
        },
      );
      instance.events.subscribe('patient.registered', async (message) => {
        received.push(message);
      });
    },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Outbox General');
  clinic = await createTenant(pool, 'Outbox Clinic');
});

afterAll(async () => {
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

/** Reads the outbox the way the dispatcher does: across every hospital. */
async function pendingFor(tenantId: string): Promise<{ event: string; entity_id: string }[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const { rows } = await client.query(
      'select event, entity_id from outbox where tenant_id = $1 and dispatched_at is null',
      [tenantId],
    );
    return rows;
  } finally {
    await client.query('rollback');
    client.release();
  }
}

const register = (tenantId: string, entityId: string, fail = false) =>
  app.inject({
    method: 'POST',
    url: '/patients',
    headers: as(tenantId),
    payload: { entityId, fail },
  });

describe('transactional outbox', () => {
  it('emits no event when the transaction rolls back', async () => {
    expect((await register(hospital.id, 'p-rolled-back', true)).statusCode).toBe(500);
    expect(await pendingFor(hospital.id)).toEqual([]);
    expect(await app.events.dispatch()).toBe(0);
  });

  it('keeps an event from a committed request and delivers it once, to its subscriber', async () => {
    expect((await register(hospital.id, 'p-1')).statusCode).toBe(200);
    expect(await pendingFor(hospital.id)).toEqual([
      { event: 'patient.registered', entity_id: 'p-1' },
    ]);

    expect(await app.events.dispatch()).toBe(1);
    expect(await app.events.dispatch()).toBe(0);
    expect(await pendingFor(hospital.id)).toEqual([]);

    await queue.drain();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      tenantId: hospital.id,
      event: 'patient.registered',
      entityId: 'p-1',
      actorId: 'user_test',
      payload: { source: 'test' },
    });
    // The id lets an idempotent subscriber recognise a repeat.
    expect(queue.sent.at(-1)?.options.id).toBe(received[0]?.eventId);
  });

  it('labels each event with the hospital of the request that emitted it', async () => {
    await register(clinic.id, 'p-clinic');
    expect(await pendingFor(hospital.id)).toEqual([]);
    expect(await pendingFor(clinic.id)).toEqual([
      { event: 'patient.registered', entity_id: 'p-clinic' },
    ]);
    await app.events.dispatch();
  });

  it('refuses an event written for another hospital, and hides the outbox from tenants', async () => {
    await asTenantSql(pool, clinic.id, async (client) => {
      await client.query('savepoint s1');
      await expect(
        client.query("insert into outbox (tenant_id, event) values ($1, 'patient.registered')", [
          hospital.id,
        ]),
      ).rejects.toThrow(/row-level security policy/);
      await client.query('rollback to savepoint s1');
      await expect(client.query('select * from outbox')).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('rejects a name that is not an event', async () => {
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query("insert into outbox (tenant_id, event) values (app_tenant_id(), 'Bad Name')"),
      ).rejects.toThrow(/outbox_event_check/);
    });
  });

  it('does not let an event the queue refuses hold back the others, and stops after a few tries', async () => {
    await register(hospital.id, 'p-poison');
    await register(hospital.id, 'p-fine');
    queue.refuse = 'p-poison';
    try {
      expect(await app.events.dispatch()).toBe(1);
      expect((await pendingFor(hospital.id)).map((row) => row.entity_id)).toEqual(['p-poison']);

      for (let run = 1; run < MAX_ATTEMPTS; run++) await app.events.dispatch();
      const { rows } = await asWorker(
        "select attempts from outbox where tenant_id = $1 and entity_id = 'p-poison'",
        hospital.id,
      );
      expect(rows).toEqual([{ attempts: MAX_ATTEMPTS }]);

      // Given up on: even once the queue recovers, it is not picked up again.
      queue.refuse = null;
      expect(await app.events.dispatch()).toBe(0);
    } finally {
      queue.refuse = null;
    }
  });

  it('drops a repeated send of the same event id', async () => {
    const before = queue.sent.length;
    await queue.send('event.patient.registered', {}, { id: 'same' });
    await queue.send('event.patient.registered', {}, { id: 'same' });
    expect(queue.sent).toHaveLength(before + 1);
  });
});

async function asWorker(text: string, tenantId: string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    return await client.query<{ attempts: number }>(text, [tenantId]);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
