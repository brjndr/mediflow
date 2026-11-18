import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, resolveTestSession } from '../../../test/helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    extend(instance) {
      instance.get('/headers-probe', { config: { access: 'public' } }, async () => ({ ok: true }));
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe('security headers', () => {
  it('sends them on a success and on a refusal', async () => {
    for (const url of ['/headers-probe', '/no-such-route']) {
      const { headers } = await app.inject({ method: 'GET', url });
      expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(headers['content-security-policy']).toContain("default-src 'none'");
      expect(headers['cache-control']).toBe('private, no-store');
    }
  });
});
