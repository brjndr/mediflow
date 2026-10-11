import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  as,
  asTenantSql,
  buildTestApp,
  createTenant,
  deleteTenants,
  resolveTestSession,
  type TestTenant,
} from '../../../test/helpers.js';
import { purgeExpiredKeys } from './plugin.js';

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let runs = 0;

const create = (
  url: string,
  options: { tenant?: TestTenant; user?: string; key?: string; body?: object } = {},
) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      ...as((options.tenant ?? hospital).id, options.user ?? 'user_a'),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    payload: options.body ?? { name: 'first' },
  });

const KEY = () => `key-${randomUUID()}`;

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    extend(instance) {
      const handler = async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { fail?: boolean; delay?: number };
        runs++;
        if (body.delay) await new Promise((resolve) => setTimeout(resolve, body.delay));
        if (body.fail) throw new Error('failed after the key was claimed');
        reply.status(201);
        return { id: randomUUID(), detail: 'patient detail' };
      };
      // Defaults: only the status and the new id are kept.
      instance.post('/things', { config: { permissions: [], idempotent: true } }, handler);
      instance.post(
        '/open-things',
        { config: { permissions: [], idempotent: { body: 'full' } } },
        handler,
      );
      instance.post(
        '/payments',
        { config: { permissions: [], idempotent: { required: true } } },
        handler,
      );
      // The response schema removes `detail`, so it must not be stored or replayed either.
      instance.post(
        '/stripped',
        {
          config: { permissions: [], idempotent: { body: 'full' } },
          schema: { response: { 201: Type.Object({ id: Type.String() }) } },
        },
        handler,
      );
      instance.post(
        '/empty',
        { config: { permissions: [], idempotent: true } },
        async (_request, reply) => {
          runs++;
          return reply.status(204).send();
        },
      );
      instance.post(
        '/audited',
        { config: { permissions: [], idempotent: true, audit: { entity: 'idem_audited' } } },
        handler,
      );
    },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Idem General');
  clinic = await createTenant(pool, 'Idem Clinic');
});

afterAll(async () => {
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

beforeEach(() => {
  runs = 0;
});

describe('Idempotency-Key', () => {
  it('replays the first result and does the work once', async () => {
    const key = KEY();
    const first = await create('/open-things', { key });
    const second = await create('/open-things', { key });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(runs).toBe(1);
  });

  it('keeps only the status and the id unless the route says otherwise', async () => {
    const key = KEY();
    const first = await create('/things', { key });
    const second = await create('/things', { key });

    expect(first.json().detail).toBe('patient detail');
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual({ id: first.json().id });
    expect(runs).toBe(1);

    const stored = await asTenantSql(pool, hospital.id, (client) =>
      client.query('select response_body from idempotency_keys where key = $1', [key]),
    );
    expect(JSON.stringify(stored.rows)).not.toContain('patient detail');
  });

  it('refuses the same key for a different request', async () => {
    const key = KEY();
    await create('/things', { key, body: { name: 'one' } });
    const reused = await create('/things', { key, body: { name: 'two' } });

    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('idempotency_key_reuse');
    expect(runs).toBe(1);
  });

  it('scopes a key to the user and the hospital', async () => {
    const key = KEY();
    await create('/things', { key });
    await create('/things', { key, user: 'user_b' });
    await create('/things', { key, tenant: clinic });
    expect(runs).toBe(3);
  });

  it('leaves no key behind when the first request fails, so a retry works', async () => {
    const key = KEY();
    expect((await create('/things', { key, body: { fail: true } })).statusCode).toBe(500);
    const retry = await create('/things', { key, body: { fail: true } });
    expect(retry.statusCode).toBe(500);
    expect(runs).toBe(2);

    // The same key can still be used for the request the client really means.
    expect((await create('/things', { key, body: { name: 'fixed' } })).statusCode).toBe(201);
  });

  it('makes two requests with the same key at once do the work once', async () => {
    const key = KEY();
    const [one, two] = await Promise.all([
      create('/things', { key, body: { delay: 150 } }),
      create('/things', { key, body: { delay: 150 } }),
    ]);
    expect(runs).toBe(1);
    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(201);
    expect(two.json().id).toBe(one.json().id);
  });

  it('works without a key, and rejects a key that is not valid or is missing where required', async () => {
    await create('/things');
    await create('/things');
    expect(runs).toBe(2);

    const invalid = await create('/things', { key: 'bad key!!' });
    expect(invalid.statusCode).toBe(400);

    const missing = await create('/payments');
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('idempotency_key_required');
    expect((await create('/payments', { key: KEY() })).statusCode).toBe(201);
  });

  it('reclaims an expired key, and the purge job removes expired rows', async () => {
    const key = KEY();
    await create('/things', { key });

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_app');
      await client.query("select set_config('app.tenant_id', $1, true)", [hospital.id]);
      await client.query(
        "update idempotency_keys set expires_at = now() - interval '1 hour' where key = $1",
        [key],
      );
      await client.query('commit');
    } finally {
      client.release();
    }

    expect((await create('/things', { key })).statusCode).toBe(201);
    expect(runs).toBe(2);

    const stale = KEY();
    await create('/things', { key: stale });
    const expire = await pool.connect();
    try {
      await expire.query('begin');
      await expire.query('set local role mediflow_app');
      await expire.query("select set_config('app.tenant_id', $1, true)", [hospital.id]);
      await expire.query(
        "update idempotency_keys set expires_at = now() - interval '1 hour' where key = $1",
        [stale],
      );
      await expire.query('commit');
    } finally {
      expire.release();
    }
    await purgeExpiredKeys(pool);
    const left = await asTenantSql(pool, hospital.id, (c) =>
      c.query('select 1 from idempotency_keys where key = $1', [stale]),
    );
    expect(left.rowCount).toBe(0);
  });
});

describe('tenant isolation of stored keys', () => {
  it('hides one hospital keys from another and refuses writing for another', async () => {
    const key = KEY();
    await create('/things', { key });

    await asTenantSql(pool, clinic.id, async (client) => {
      const { rowCount } = await client.query('select 1 from idempotency_keys where key = $1', [
        key,
      ]);
      expect(rowCount).toBe(0);
      await expect(
        client.query(
          `insert into idempotency_keys (tenant_id, user_id, key, request_hash, expires_at)
           values ($1, 'u', 'abcdefgh-1', 'h', now() + interval '1 hour')`,
          [hospital.id],
        ),
      ).rejects.toThrow(/row-level security policy/);
    });
  });
});

describe('what is stored and replayed', () => {
  it('keeps what the client was sent, not the fields the response schema removed', async () => {
    const key = KEY();
    const first = await create('/stripped', { key });
    expect(first.json()).toEqual({ id: first.json().id });

    const second = await create('/stripped', { key });
    expect(second.json()).toEqual(first.json());
    const stored = await asTenantSql(pool, hospital.id, (client) =>
      client.query('select response_body from idempotency_keys where key = $1', [key]),
    );
    expect(JSON.stringify(stored.rows)).not.toContain('patient detail');
  });

  it('replays an empty 204 instead of leaving the key unfinished', async () => {
    const key = KEY();
    expect((await create('/empty', { key })).statusCode).toBe(204);
    const again = await create('/empty', { key });
    expect(again.statusCode).toBe(204);
    expect(again.body).toBe('');
    expect(runs).toBe(1);
  });

  it('treats a different query string as a different request', async () => {
    const key = KEY();
    await create('/things?mode=a', { key });
    const other = await create('/things?mode=b', { key });
    expect(other.statusCode).toBe(422);
    expect((await create('/things?mode=a', { key })).statusCode).toBe(201);
    expect(runs).toBe(1);
  });

  it('audits the work once, not once per replay', async () => {
    const key = KEY();
    await create('/audited', { key });
    await create('/audited', { key });
    const rows = await asTenantSql(pool, hospital.id, (client) =>
      client.query("select 1 from audit_log where entity = 'idem_audited' and entity_id is null"),
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe('route declaration', () => {
  it('stops the app from starting for a read-only or non-tenant idempotent route', async () => {
    const failures: string[] = [];
    const other = await buildTestApp({
      extend(instance) {
        const attempt = (register: () => void) => {
          try {
            register();
          } catch (error) {
            failures.push(String(error));
          }
        };
        attempt(() =>
          instance.get(
            '/read',
            { config: { permissions: [], idempotent: true } },
            async () => ({}),
          ),
        );
        attempt(() =>
          instance.post(
            '/open',
            { config: { access: 'public', idempotent: true } },
            async () => ({}),
          ),
        );
      },
    });
    await other.close();
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/read-only method/);
    expect(failures[1]).toMatch(/not a tenant route/);
  });
});
