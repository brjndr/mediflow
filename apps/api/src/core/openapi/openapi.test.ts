import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../test/helpers.js';
import { registerErrorHandling } from '../http/errors.js';
import { CursorPage, CursorQuery, errors, ref } from '../http/schemas.js';
import { CONTRACT_VERSION, openApiPlugin } from './plugin.js';

type Operation = { operationId?: string; responses?: Record<string, { content?: unknown }> };
const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

describe('generated OpenAPI document', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(() => app.close());

  const operations = () =>
    Object.entries(app.swagger().paths ?? {}).flatMap(([path, item]) =>
      METHODS.flatMap((method) => {
        const operation = (item as Record<string, Operation | undefined>)[method];
        return operation ? [{ label: `${method.toUpperCase()} ${path}`, operation }] : [];
      }),
    );

  it('describes every route, each with a unique operationId', () => {
    const all = operations();
    expect(all.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['GET /health', 'GET /health/ready']),
    );
    const ids = all.map((entry) => entry.operation.operationId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every response a schema, so the client is typed end to end', () => {
    for (const { label, operation } of operations()) {
      const responses = Object.entries(operation.responses ?? {});
      expect(responses.length, label).toBeGreaterThan(0);
      for (const [status, response] of responses) {
        if (status === '204' || status === '304') continue;
        expect(response.content, `${label} ${status}`).toBeDefined();
      }
    }
  });

  it('names shared schemas after their $id and uses the one error body', () => {
    const document = app.swagger() as unknown as {
      info: { version: string };
      components: { schemas: Record<string, unknown> };
      paths: Record<string, { get: { responses: Record<string, unknown> } }>;
    };
    expect(document.info.version).toBe(CONTRACT_VERSION);
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining(['Error', 'Health']),
    );
    expect(JSON.stringify(document.paths['/health/ready']?.get.responses['503'])).toContain(
      '#/components/schemas/Error',
    );
    // No anonymous def-0 style names.
    expect(Object.keys(document.components.schemas).some((name) => /^def-\d+$/.test(name))).toBe(
      false,
    );
  });

  it('matches the committed api.openapi.json (run pnpm gen:api if this fails)', () => {
    const committed = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../../../../packages/contract/api.openapi.json', import.meta.url),
        ),
        'utf8',
      ),
    );
    expect(JSON.parse(JSON.stringify(app.swagger()))).toEqual(committed);
  });
});

describe('pagination and error schema helpers', () => {
  const Item = Type.Object({ id: Type.String(), label: Type.String() }, { $id: 'Item' });
  const ItemPage = CursorPage(ref(Item), { $id: 'ItemPage' });
  let app: FastifyInstance;

  beforeAll(async () => {
    const instance = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    registerErrorHandling(instance);
    await instance.register(openApiPlugin);
    instance.addSchema(Item);
    instance.addSchema(ItemPage);
    instance.get(
      '/items',
      {
        schema: {
          operationId: 'listItems',
          querystring: CursorQuery,
          response: { 200: ref(ItemPage), ...errors(400, 401) },
        },
      },
      async (request) => ({
        // `secret` is not in the schema, so it must never reach the client.
        items: [{ id: 'i1', label: `limit ${request.query.limit}`, secret: 'internal' }],
        nextCursor: request.query.cursor ? null : 'i1',
      }),
    );
    await instance.ready();
    app = instance;
  });
  afterAll(() => app.close());

  it('defaults the page size and returns the cursor envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/items' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ id: 'i1', label: 'limit 25' }],
      nextCursor: 'i1',
    });
  });

  it('strips fields the response schema does not declare', async () => {
    const response = await app.inject({ method: 'GET', url: '/items' });
    expect(response.body).not.toContain('internal');
  });

  it('returns a null cursor on the last page', async () => {
    const response = await app.inject({ method: 'GET', url: '/items?cursor=i1&limit=50' });
    expect(response.json()).toEqual({ items: [{ id: 'i1', label: 'limit 50' }], nextCursor: null });
  });

  it.each(['0', '101', '2.5', 'all'])('rejects limit=%s with the standard error', async (limit) => {
    const response = await app.inject({ method: 'GET', url: `/items?limit=${limit}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('puts the envelope and the item in the contract by name', () => {
    const document = JSON.stringify(app.swagger());
    expect(document).toContain('"ItemPage"');
    expect(document).toContain('#/components/schemas/Item"');
    expect(document).toContain('"nextCursor"');
  });

  it('refuses to reference a schema that has no $id', () => {
    expect(() => ref(Type.Object({ id: Type.String() }))).toThrow(/needs a schema with an \$id/);
  });

  it('maps each listed status to the error body', () => {
    expect(Object.keys(errors(401, 403, 404))).toEqual(['401', '403', '404']);
    expect(errors(401)[401].$ref).toBe('Error#');
  });
});
