import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  buildTestApp,
  createTenant,
  deleteTenants,
  resolveTestSession,
  type TestTenant,
} from '../../../test/helpers.js';
import { MemoryRateLimiter } from './limiter.js';

let app: FastifyInstance;
let pool: pg.Pool;
let tenants: TestTenant[] = [];
let payments = 0;

const ping = (tenant: TestTenant, user: string) =>
  app.inject({ method: 'GET', url: '/ping', headers: as(tenant.id, user) });

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 3, RATE_LIMIT_TENANT_PER_MINUTE: 8 },
    extend(instance) {
      instance.get('/ping', { config: { permissions: [] } }, async () => ({ ok: true }));
      instance.get('/open', { config: { access: 'public' } }, async () => ({ ok: true }));
      instance.post('/pay', { config: { permissions: [], idempotent: true } }, async () => {
        payments++;
        return { id: 'p-1' };
      });
    },
  });
  pool = app.database.pool;
  tenants = [
    await createTenant(pool, 'Limit One'),
    await createTenant(pool, 'Limit Two'),
    await createTenant(pool, 'Limit Three'),
    await createTenant(pool, 'Limit Four'),
  ];
});

afterAll(async () => {
  await deleteTenants(pool, tenants);
  await app.close();
});

describe('per-user limit', () => {
  it('answers 429 with Retry-After once a user is over, and leaves other users alone', async () => {
    const [one] = tenants as [TestTenant];
    for (let hit = 0; hit < 3; hit++) expect((await ping(one, 'user_a')).statusCode).toBe(200);

    const refused = await ping(one, 'user_a');
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('rate_limited');
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    expect((await ping(one, 'user_b')).statusCode).toBe(200);
  });
});

describe('per-hospital limit', () => {
  it('limits a whole hospital without touching another', async () => {
    const [, two, three] = tenants as [TestTenant, TestTenant, TestTenant];
    // Nine requests from three users, each within the user limit: the ninth passes the hospital's.
    const statuses: number[] = [];
    for (const user of ['user_c', 'user_d', 'user_e']) {
      for (let hit = 0; hit < 3; hit++) statuses.push((await ping(two, user)).statusCode);
    }
    expect(statuses.slice(0, 8).every((status) => status === 200)).toBe(true);
    expect(statuses[8]).toBe(429);

    expect((await ping(three, 'user_c')).statusCode).toBe(200);
  });
});

describe('a runaway user', () => {
  it('does not use up the hospital share, and is refused before an idempotent route runs', async () => {
    const four = tenants[3] as TestTenant;
    const pay = () =>
      app.inject({
        method: 'POST',
        url: '/pay',
        headers: { ...as(four.id, 'user_x'), 'idempotency-key': 'pay-key-0001' },
        payload: {},
      });
    const statuses: number[] = [];
    for (let hit = 0; hit < 20; hit++) statuses.push((await pay()).statusCode);
    // The first request creates, the next two within the limit are replays of it.
    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(17);
    expect(payments).toBe(1);

    // 3 of the hospital's 8 were used, not 20: its other users still get their share.
    for (const user of ['user_y', 'user_z']) {
      for (let hit = 0; hit < 2; hit++) expect((await ping(four, user)).statusCode).toBe(200);
    }
  });
});

describe('routes without a hospital', () => {
  it('does not count public routes', async () => {
    for (let hit = 0; hit < 10; hit++) {
      expect((await app.inject({ method: 'GET', url: '/open' })).statusCode).toBe(200);
    }
  });
});

describe('MemoryRateLimiter', () => {
  it('opens a new window when the old one ends', async () => {
    let now = 1_000;
    const limiter = new MemoryRateLimiter(() => now);
    expect((await limiter.hit('k', 1, 60_000)).allowed).toBe(true);
    const refused = await limiter.hit('k', 1, 60_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 60 });

    now += 30_000;
    expect((await limiter.hit('k', 1, 60_000)).retryAfterSeconds).toBe(30);
    now += 30_000;
    expect((await limiter.hit('k', 1, 60_000)).allowed).toBe(true);
  });
});
