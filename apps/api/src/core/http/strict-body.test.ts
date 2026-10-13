import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../test/helpers.js';
import { ref } from './schemas.js';
import { wrongType } from './strict-body.js';

/**
 * A JSON body is checked for the types it was sent with, before the validator can coerce them.
 * Query strings and path parameters are text, and are coerced as before.
 */

const Line = Type.Object(
  {
    amount: Type.Integer({ minimum: 0 }),
    note: Type.Optional(Type.String()),
  },
  { $id: 'StrictProbeLine' },
);

const Body = Type.Object(
  {
    amount: Type.Integer({ minimum: 0 }),
    rate: Type.Optional(Type.Number()),
    active: Type.Optional(Type.Boolean()),
    name: Type.Optional(Type.String()),
    // A number or nothing, said as one schema with both types.
    level: Type.Optional(Type.Unsafe<number | null>({ type: ['integer', 'null'] })),
    // The same, said as a union. Not for a number that can be 0: see the test below.
    either: Type.Optional(Type.Union([Type.Null(), Type.Integer()])),
    tags: Type.Optional(Type.Array(Type.String())),
    lines: Type.Optional(Type.Array(ref(Line))),
  },
  { additionalProperties: false },
);

let app: FastifyInstance;

const send = (payload: unknown, url = '/strict-probe') =>
  app.inject({ method: 'POST', url, payload: payload as object });

beforeAll(async () => {
  app = await buildTestApp({
    async extend(instance) {
      // As a feature does: its schemas are known to its own plugin only.
      await instance.register(async (feature) => {
        feature.addSchema(Line);
        feature.post(
          '/strict-probe',
          { config: { access: 'public' }, schema: { body: Body } },
          async (request) => request.body,
        );
      });
      instance.get(
        '/strict-probe/:count',
        {
          config: { access: 'public' },
          schema: {
            params: Type.Object({ count: Type.Integer() }),
            querystring: Type.Object({ limit: Type.Integer(), flag: Type.Boolean() }),
          },
        },
        async (request) => ({ ...(request.params as object), ...(request.query as object) }),
      );
      instance.post('/strict-probe/free', { config: { access: 'public' } }, async (request) => ({
        got: request.body ?? null,
      }));
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe('a JSON body', () => {
  it('is taken as sent when every value has the type declared for it', async () => {
    const body = {
      amount: 0,
      rate: 1.5,
      active: false,
      name: '',
      level: null,
      either: 7,
      tags: ['a'],
      lines: [{ amount: 2, note: 'x' }],
    };
    const response = await send(body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(body);
  });

  it('keeps a 0 as 0 and a null as null where one schema allows both', async () => {
    expect((await send({ amount: 1, level: 0, either: null })).json()).toEqual({
      amount: 1,
      level: 0,
      either: null,
    });
    expect((await send({ amount: 1, level: null })).json()).toEqual({ amount: 1, level: null });
  });

  it('cannot save a union of null and a number from the validator, which is why none is used', async () => {
    // Both types are allowed, so the 0 passes the check, and the validator then turns it into the
    // first branch of the union. A nullable number is one schema with both types (`level`).
    expect((await send({ amount: 1, either: 0 })).json()).toEqual({ amount: 1, either: null });
  });

  it('refuses a value sent as another type, where it used to be turned into one', async () => {
    const bad: [string, object][] = [
      // These were coerced to 0, 1, false and "" before.
      ['body.amount', { amount: null }],
      ['body.amount', { amount: true }],
      ['body.amount', { amount: '5' }],
      ['body.rate', { amount: 1, rate: null }],
      ['body.active', { amount: 1, active: null }],
      ['body.active', { amount: 1, active: 'true' }],
      ['body.active', { amount: 1, active: 0 }],
      ['body.name', { amount: 1, name: null }],
      ['body.name', { amount: 1, name: 5 }],
      ['body.level', { amount: 1, level: '3' }],
      ['body.either', { amount: 1, either: false }],
      // A single value is not a list of one.
      ['body.tags', { amount: 1, tags: 'a' }],
      ['body.tags.1', { amount: 1, tags: ['a', 2] }],
      // Inside a schema that is referred to by name, too.
      ['body.lines.0.amount', { amount: 1, lines: [{ amount: null }] }],
      ['body.lines.1.note', { amount: 1, lines: [{ amount: 1 }, { amount: 1, note: null }] }],
      ['body.lines.0', { amount: 1, lines: [null] }],
    ];
    for (const [path, body] of bad) {
      const response = await send(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      const { error } = response.json<{ error: { code: string; message: string } }>();
      expect(error.code).toBe('validation_failed');
      expect(error.message, JSON.stringify(body)).toContain(`${path} `);
    }
  });

  it('refuses a body that is not the object declared', async () => {
    for (const body of [[], 'text', 5, null]) {
      const response = await app.inject({
        method: 'POST',
        url: '/strict-probe',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('leaves everything else to the validator', async () => {
    // A missing required field, a value out of range and an unknown field are not its business.
    expect((await send({})).statusCode).toBe(400);
    expect((await send({ amount: -1 })).statusCode).toBe(400);
    expect((await send({ amount: 1.5 })).statusCode).toBe(400);
    expect((await send({ amount: 1, unknown: null })).json()).toEqual({ amount: 1 });
  });

  it('says where, and never what was sent', async () => {
    const response = await send({ amount: 1, name: { secret: 'Asha Rao' } });
    expect(response.body).not.toContain('Asha');
    expect(response.json<{ error: { message: string } }>().error.message).toContain('body.name ');
  });
});

describe('what is not a JSON body', () => {
  it('still turns the text of a path and a query string into numbers and booleans', async () => {
    const response = await app.inject({ url: '/strict-probe/7?limit=25&flag=true' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 7, limit: 25, flag: true });
  });

  it('does not look at a route that declares no body', async () => {
    const response = await send({ anything: null }, '/strict-probe/free');
    expect(response.json()).toEqual({ got: { anything: null } });
  });
});

describe('wrongType', () => {
  const none = () => undefined;

  it('follows a schema that is too deep or unknown no further, and reports nothing', () => {
    expect(wrongType(undefined, 5, none)).toBeNull();
    expect(wrongType({ $ref: 'Missing#' }, 5, none)).toBeNull();
    expect(wrongType({ type: 'made-up' }, 5, none)).toBeNull();
    const loop: Record<string, unknown> = { type: 'object' };
    loop.properties = { next: loop };
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let depth = 0; depth < 40; depth++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(wrongType(loop, nested, none)).toBeNull();
  });
});
