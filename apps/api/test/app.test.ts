import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('API', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(() => app.close());

  describe('health', () => {
    it('answers the liveness check', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('answers the readiness check when the database is reachable', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });
  });

  describe('database', () => {
    it('has the migrations applied', async () => {
      const { rows } = await app.database.pool.query<{ extname: string }>(
        "select extname from pg_extension where extname in ('pgcrypto', 'pg_trgm', 'btree_gist') order by 1",
      );
      expect(rows.map((row) => row.extname)).toEqual(['btree_gist', 'pg_trgm', 'pgcrypto']);

      const applied = await app.database.pool.query(
        'select name from schema_migrations order by name',
      );
      expect(applied.rows[0]).toEqual({ name: '0001_extensions.sql' });
    });

    it('runs against the test database', async () => {
      const { rows } = await app.database.pool.query<{ name: string }>(
        'select current_database() as name',
      );
      expect(rows[0]?.name).toMatch(/test/);
    });
  });

  describe('errors', () => {
    it('answers an unknown route with the standard error body', async () => {
      const response = await app.inject({ method: 'GET', url: '/no/such/route' });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body).toEqual({
        error: {
          code: 'not_found',
          message: 'No such route',
          requestId: expect.stringMatching(UUID),
        },
      });
      expect(response.headers['x-request-id']).toBe(body.error.requestId);
    });

    it('generates its own request id and ignores one sent by the client', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': 'forged-by-client', 'request-id': 'forged-by-client' },
      });
      expect(response.headers['x-request-id']).toMatch(UUID);
    });

    it('answers malformed JSON with a client error, not a 500', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/health',
        headers: { 'content-type': 'application/json' },
        payload: '{"broken": ',
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.json().error.code).toMatch(/^(bad_request|not_found)$/);
    });
  });
});

describe('readiness without a database', () => {
  it('answers 503 with the standard error body', async () => {
    // Nothing listens on this port, so every connection attempt is refused at once.
    const app = await buildTestApp({
      config: { DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'database_unavailable' } });
      // Liveness does not depend on the database.
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
