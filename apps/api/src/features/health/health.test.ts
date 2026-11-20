import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../test/helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});

const check = () => app.inject({ method: 'GET', url: '/health/scanner' });
const builtHoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

describe('GET /health/scanner (#1064)', () => {
  it('is ok for a scanner with nothing to check', async () => {
    expect((await check()).statusCode).toBe(200);
  });

  it('is ok with fresh signatures, and 503 when unreachable or stale', async () => {
    const scanner = app.scanner as { health?: () => Promise<unknown> };
    scanner.health = async () => ({ reachable: true, signaturesBuiltAt: builtHoursAgo(3) });
    expect((await check()).statusCode).toBe(200);

    scanner.health = async () => ({ reachable: false, signaturesBuiltAt: null });
    const down = await check();
    expect(down.statusCode).toBe(503);
    expect(down.json().code ?? down.json().error?.code).toBe('scanner_unavailable');

    scanner.health = async () => ({ reachable: true, signaturesBuiltAt: builtHoursAgo(72) });
    expect((await check()).statusCode).toBe(503);

    scanner.health = async () => ({ reachable: true, signaturesBuiltAt: null });
    expect((await check()).statusCode).toBe(503);
  });
});
