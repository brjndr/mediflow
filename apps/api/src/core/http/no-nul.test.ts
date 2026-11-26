import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../test/helpers.js';
import { holdsNul } from './no-nul.js';

/**
 * A NUL in any text of a request is a 400 before validation, never a 500 from the database
 * (#1183).
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp({
    async extend(instance) {
      instance.post(
        '/nul-probe/:code',
        {
          config: { access: 'public' },
          schema: {
            params: Type.Object({ code: Type.String() }),
            querystring: Type.Object({ q: Type.Optional(Type.String()) }),
            body: Type.Object({
              name: Type.Optional(Type.String()),
              lines: Type.Optional(Type.Array(Type.Object({ note: Type.String() }))),
            }),
          },
        },
        async () => ({ ok: true }),
      );
    },
  });
});

afterAll(async () => {
  await app.close();
});

const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

describe('a NUL in a request', () => {
  it('lets a request without one through', async () => {
    const response = await post('/nul-probe/abc?q=x', { name: 'Asha', lines: [{ note: 'ok' }] });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['a body text', '/nul-probe/abc', { name: 'As\u0000ha' }, 'body'],
    [
      'a nested body text',
      '/nul-probe/abc',
      { lines: [{ note: 'a' }, { note: '\u0000' }] },
      'body',
    ],
    ['a body field name', '/nul-probe/abc', { 'na\u0000me': 'x' }, 'body'],
    ['the query string', '/nul-probe/abc?q=a%00b', {}, 'query'],
    ['a path parameter', '/nul-probe/a%00b', {}, 'path'],
  ])(
    'refuses one in %s with 400, naming the part and not the value',
    async (_, url, body, part) => {
      const response = await post(url, body);
      expect(response.statusCode).toBe(400);
      const { error } = response.json();
      expect(error.code).toBe('validation_failed');
      expect(error.message).toBe(`The ${part} holds a NUL character`);
    },
  );

  it('is refused on the forgot-password route, which answered 500 before', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      headers: { origin: app.config.APP_BASE_URL },
      payload: { email: 'someone\u0000@example.test' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_failed');
  });
});

describe('holdsNul', () => {
  it('looks into plain objects and arrays only', () => {
    expect(holdsNul(Buffer.from([0]))).toBe(false);
    expect(holdsNul(undefined)).toBe(false);
    expect(holdsNul([['\u0000']])).toBe(true);
  });

  it('follows a deeply nested body without exhausting the stack', () => {
    let deep: unknown = '\u0000';
    for (let level = 0; level < 100_000; level += 1) deep = [deep];
    expect(holdsNul(deep)).toBe(true);
  });
});
