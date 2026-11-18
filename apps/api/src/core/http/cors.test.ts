import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, resolveTestSession } from '../../../test/helpers.js';

let app: FastifyInstance;
const APP = 'http://localhost:5173';
const EXTRA = 'https://admin.example.test';

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { APP_BASE_URL: APP, CORS_ALLOWED_ORIGINS: `${EXTRA}, https://b.example.test` },
    extend(instance) {
      instance.get('/cors-probe', { config: { access: 'public' } }, async () => ({ ok: true }));
    },
  });
});

afterAll(async () => {
  await app.close();
});

const preflight = (origin: string) =>
  app.inject({
    method: 'OPTIONS',
    url: '/cors-probe',
    headers: { origin, 'access-control-request-method': 'POST' },
  });

describe('CORS', () => {
  it('answers a preflight from the app and from a listed origin, with credentials', async () => {
    for (const origin of [APP, EXTRA, 'https://b.example.test']) {
      const res = await preflight(origin);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  it('refuses a preflight from any other origin', async () => {
    const res = await preflight('https://evil.example.test');
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('gives an actual request from another origin no CORS header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/cors-probe',
      headers: { origin: 'https://evil.example.test' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('leaves a request without an Origin alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/cors-probe' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
