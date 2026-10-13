import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  buildTestApp,
  createTenant,
  deleteTenants,
  resolveTestSession,
  type TestTenant,
} from '../../../test/helpers.js';
import { HttpError } from './errors.js';

/**
 * No answer of the API is kept by a browser or a cache, without a route having to say so. A route
 * that says something else on purpose is left alone: that the access policy keeps its own header
 * is checked with the policy, in core/access/access.test.ts.
 */

let app: FastifyInstance;
let hospital: TestTenant;

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    extend(instance) {
      instance.get('/cache-probe/public', { config: { access: 'public' } }, async () => ({
        ok: true,
      }));
      instance.get('/cache-probe/session', { config: { access: 'session' } }, async () => ({
        ok: true,
      }));
      instance.get('/cache-probe/tenant', { config: { permissions: [] } }, async () => ({
        ok: true,
      }));
      instance.get('/cache-probe/refused', { config: { access: 'session' } }, async () => {
        throw new HttpError(404, 'probe_not_found', 'No such probe');
      });
      instance.get('/cache-probe/own', { config: { access: 'session' } }, async (_request, reply) =>
        reply.header('cache-control', 'private, no-cache').send({ ok: true }),
      );
      instance.get(
        '/cache-probe/own-then-refused',
        { config: { access: 'session' } },
        async (_request, reply) => {
          void reply.header('cache-control', 'private, max-age=60').header('etag', '"probe"');
          throw new HttpError(409, 'probe_conflict', 'The probe changed its mind');
        },
      );
    },
  });
  hospital = await createTenant(app.database.pool, 'Cache Hospital');
});

afterAll(async () => {
  await deleteTenants(app.database.pool, [hospital]);
  await app.close();
});

describe('the cache default', () => {
  it('says of a tenant route that its answer is not to be stored', async () => {
    const probe = await get('/cache-probe/tenant', as(hospital.id));
    expect(probe.statusCode).toBe(200);
    expect(probe.headers['cache-control']).toBe('private, no-store');

    // A route of the app itself, which sets no header of its own.
    const tenant = await get('/tenant', as(hospital.id));
    expect(tenant.statusCode).toBe(200);
    expect(tenant.headers['cache-control']).toBe('private, no-store');
  });

  it('says so of a session route and of a public one', async () => {
    for (const url of ['/cache-probe/session', '/cache-probe/public']) {
      const answer = await get(url, as(null));
      expect(answer.statusCode, url).toBe(200);
      expect(answer.headers['cache-control'], url).toBe('private, no-store');
    }
  });

  it('says so of a refusal, whoever made it', async () => {
    const answers = {
      401: await get('/cache-probe/tenant'),
      404: await get('/cache-probe/refused', as(null)),
      409: await get('/cache-probe/tenant', as(null)),
    };
    for (const [status, answer] of Object.entries(answers)) {
      expect(answer.statusCode).toBe(Number(status));
      expect(answer.headers['cache-control'], status).toBe('private, no-store');
    }
    const unknown = await get('/cache-probe/no-such-route');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['cache-control']).toBe('private, no-store');
  });

  it('leaves the header of a route that set its own', async () => {
    const answer = await get('/cache-probe/own', as(null));
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['cache-control']).toBe('private, no-cache');
  });

  it('does not let a route that set its own and then refused say so of the refusal', async () => {
    const answer = await get('/cache-probe/own-then-refused', as(null));
    expect(answer.statusCode).toBe(409);
    expect(answer.headers['cache-control']).toBe('private, no-store');
    expect(answer.headers.etag).toBeUndefined();
  });

  it('says so of an address the router cannot read, and does not repeat the address', async () => {
    const answer = await get('/cache-probe/%E0%A4%A');
    expect(answer.statusCode).toBe(400);
    expect(answer.headers['cache-control']).toBe('private, no-store');
    expect(answer.json()).toEqual({
      error: {
        code: 'bad_request',
        message: 'The request could not be processed',
        requestId: answer.headers['x-request-id'],
      },
    });
  });
});
