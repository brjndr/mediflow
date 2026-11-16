import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { purgeAccountEvents } from './retention.js';

let app: FastifyInstance;
let pool: pg.Pool;
let plain: TestTenant;
let long: TestTenant;
const users: TestUser[] = [];

beforeAll(async () => {
  app = await buildTestApp();
  pool = app.database.pool;
  plain = await createTenant(pool, 'Retention Plain');
  long = await createTenant(pool, 'Retention Long');
  await pool.query(
    'insert into account_event_settings (tenant_id, retention_days) values ($1, 1000)',
    [long.id],
  );
});

afterAll(async () => {
  await deleteUsers(pool, users);
  await pool.query('delete from account_event_settings where tenant_id = $1', [long.id]);
  await deleteTenants(pool, [plain, long]);
  await app.close();
});

async function eventAt(user: TestUser, daysAgo: number) {
  await pool.query(
    "insert into account_events (user_id, action, entity, at) values ($1, 'password.changed', 'user', now() - make_interval(days => $2))",
    [user.id, daysAgo],
  );
}

async function ages(user: TestUser): Promise<number[]> {
  const { rows } = await pool.query<{ age: number }>(
    'select round(extract(epoch from now() - at) / 86400)::int as age from account_events where user_id = $1 order by at desc',
    [user.id],
  );
  return rows.map((row) => row.age);
}

describe('account events retention', () => {
  it('deletes events past two years and keeps the rest', async () => {
    const user = await createUser(pool, 'Retention Rhea');
    users.push(user);
    await addMembership(pool, user, plain);
    await eventAt(user, 800);
    await eventAt(user, 100);

    expect(await purgeAccountEvents(pool, 730)).toBeGreaterThanOrEqual(1);
    expect(await ages(user)).toEqual([100]);
  });

  it('keeps events longer for the people of a hospital that asks for it', async () => {
    const user = await createUser(pool, 'Retention Raj');
    users.push(user);
    await addMembership(pool, user, plain);
    await addMembership(pool, user, long);
    await eventAt(user, 1100);
    await eventAt(user, 800);

    await purgeAccountEvents(pool, 730);
    expect(await ages(user)).toEqual([800]);
  });

  it('is the only way to delete: others stay refused, and the worker cannot touch recent events', async () => {
    const user = await createUser(pool, 'Retention Rina');
    users.push(user);
    await eventAt(user, 5);
    await expect(
      pool.query('delete from account_events where user_id = $1', [user.id]),
    ).rejects.toThrow(/append-only/);

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_worker');
      const { rowCount } = await client.query('delete from account_events where user_id = $1', [
        user.id,
      ]);
      expect(rowCount).toBe(0);
      await expect(client.query('update account_events set action = $1', ['x'])).rejects.toThrow();
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(await ages(user)).toEqual([5]);
  });
});
