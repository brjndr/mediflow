import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../test/helpers.js';
import { ref } from './schemas.js';
import { notFollowable, wrongType } from './strict-body.js';

/**
 * A JSON body is checked for the types it was sent with, before the validator can coerce them.
 * Query strings and path parameters are text, and are coerced as before. A body schema the check
 * cannot follow stops the app from starting.
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
    // A number or nothing, and a text or nothing: one schema with both types.
    level: Type.Optional(Type.Unsafe<number | null>({ type: ['integer', 'null'] })),
    email: Type.Optional(Type.Unsafe<string | null>({ type: ['string', 'null'] })),
    // No type: an enum is the validator's alone, and it does not coerce one.
    colour: Type.Optional(Type.Unsafe<string>({ enum: ['red', 'blue'] })),
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
      email: '',
      colour: 'red',
      tags: ['a'],
      lines: [{ amount: 2, note: 'x' }],
    };
    const response = await send(body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(body);
  });

  it('keeps a 0 as 0, an empty text as empty and a null as null where the schema allows both', async () => {
    for (const body of [
      { amount: 1, level: 0, email: null },
      { amount: 1, level: null, email: '' },
    ]) {
      expect((await send(body)).json()).toEqual(body);
    }
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
      ['body.level', { amount: 1, level: false }],
      ['body.email', { amount: 1, email: 0 }],
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
    // A missing required field, a value out of range, a value not in a list and an unknown field
    // are not its business.
    expect((await send({})).statusCode).toBe(400);
    expect((await send({ amount: -1 })).statusCode).toBe(400);
    expect((await send({ amount: 1.5 })).statusCode).toBe(400);
    expect((await send({ amount: 1, colour: 'green' })).statusCode).toBe(400);
    expect((await send({ amount: 1, colour: null })).statusCode).toBe(400);
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

describe('a body schema the check cannot follow', () => {
  const starting = (body: TSchema, register?: TSchema) =>
    buildTestApp({
      async extend(instance) {
        await instance.register(async (feature) => {
          if (register) feature.addSchema(register);
          feature.post(
            '/strict-refused',
            { config: { access: 'public' }, schema: { body } },
            async () => ({}),
          );
        });
      },
    });

  it('stops the app from starting, and says which route and why', async () => {
    const cases: [RegExp, TSchema][] = [
      // A union: both types pass the check and the validator then coerces to its first branch.
      [/body\.level uses anyOf/, Type.Object({ level: Type.Union([Type.Null(), Type.Integer()]) })],
      [/body uses allOf/, Type.Intersect([Type.Object({ a: Type.Integer() }), Type.Object({})])],
      [/body\.pair has a list of schemas/, Type.Object({ pair: Type.Tuple([Type.Integer()]) })],
      [
        /body\.map uses patternProperties/,
        Type.Object({ map: Type.Record(Type.String(), Type.Integer()) }),
      ],
      [
        /body gives a schema for unnamed properties/,
        Type.Object({}, { additionalProperties: Type.Integer() }),
      ],
      [
        /body\.line refers to StrictMissing, which is not registered/,
        Type.Object({
          line: Type.Unsafe({ $ref: 'StrictMissing#' }),
        }),
      ],
      [
        /body\.part refers to a part of a schema/,
        Type.Object({
          part: Type.Unsafe({ $ref: '#/properties/other' }),
        }),
      ],
      [/body\.when has the type date/, Type.Object({ when: Type.Unsafe({ type: 'date' }) })],
      [
        /body\.list\[\]\.n uses oneOf/,
        Type.Object({
          list: Type.Array(Type.Object({ n: Type.Unsafe({ oneOf: [{ type: 'integer' }] }) })),
        }),
      ],
    ];
    for (const [reason, body] of cases) {
      await expect(starting(body), String(reason)).rejects.toThrow(reason);
    }
    await expect(
      starting(Type.Object({ n: Type.Union([Type.Null(), Type.Integer()]) })),
    ).rejects.toThrow(/POST \/strict-refused: the types of its body cannot be checked/);
  });

  it('refuses a schema that contains itself', async () => {
    const Node = Type.Object(
      { next: Type.Optional(Type.Unsafe({ $ref: 'StrictNode#' })) },
      { $id: 'StrictNode' },
    );
    await expect(starting(Type.Unsafe({ $ref: 'StrictNode#' }), Node)).rejects.toThrow(
      /refers back to StrictNode/,
    );
  });
});

describe('the two walks', () => {
  const none = () => undefined;

  it('follow what a body schema is made of', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: ['integer', 'null'] }, list: { type: 'array', items: Line } },
    };
    expect(notFollowable(schema, none)).toBeNull();
    expect(wrongType(schema, { n: null, list: [{ amount: 1 }] }, none)).toBeNull();
    expect(wrongType(schema, { n: '1' }, none)).toBe('body.n');
    // Its own fields only: every object has a `toString`, and one that was not sent is not looked at.
    const named = { type: 'object', properties: { toString: { type: 'string' } } };
    expect(wrongType(named, {}, none)).toBeNull();
    expect(wrongType(named, { toString: 5 }, none)).toBe('body.toString');
    expect(wrongType(schema, { list: [{ amount: 1 }, { amount: '1' }] }, none)).toBe(
      'body.list.1.amount',
    );
  });

  it('report a schema that is none at all', () => {
    expect(notFollowable(undefined, none)).toBe('body is not a schema');
    expect(notFollowable({ properties: { a: {} } }, none)).toBe(
      'body has properties or items and no type',
    );
    expect(wrongType(undefined, 5, none)).toBeNull();
  });
});
