// Run with: pnpm test:scripts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeSpecs } from '../packages/contract/scripts/merge-spec.mjs';
import { findBreakingChanges, versionCoversBreaking, versionRaised } from './contract-check.mjs';

const script = fileURLToPath(new URL('./contract-check.mjs', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'contract-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const ok = {
  description: 'ok',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Patient' } } },
};

/** A small but realistic contract. Each test changes one thing about it. */
const base = () => ({
  openapi: '3.1.0',
  info: { title: 'API', version: '0.3.0' },
  paths: {
    '/patients': {
      get: {
        operationId: 'listPatients',
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
        responses: { 200: ok, 401: { description: 'no' } },
      },
      post: { operationId: 'createPatient', responses: { 201: ok } },
    },
    '/patients/{id}': { get: { operationId: 'getPatient', responses: { 200: ok } } },
  },
  components: {
    schemas: {
      Patient: {
        type: 'object',
        required: ['id', 'gender'],
        properties: {
          id: { type: 'string' },
          gender: { type: 'string', enum: ['male', 'female', 'other'] },
          phone: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          contact: { type: 'object', properties: { email: { type: 'string' } } },
          department: { $ref: '#/components/schemas/Department' },
          nickname: { type: ['string', 'null'] },
        },
      },
      Department: { type: 'object', properties: { id: { type: 'string' } } },
    },
  },
});

const change = (mutate) => {
  const next = base();
  mutate(next);
  return findBreakingChanges(base(), next);
};

test('additions are not breaking', () => {
  assert.deepEqual(
    change((spec) => {
      spec.paths['/doctors'] = { get: { responses: { 200: ok } } };
      spec.paths['/patients'].delete = { responses: { 204: { description: 'gone' } } };
      spec.paths['/patients'].get.responses[403] = { description: 'forbidden' };
      spec.paths['/patients'].get.parameters.push({ name: 'cursor', in: 'query', required: false });
      spec.components.schemas.Patient.properties.email = { type: 'string' };
      spec.components.schemas.Patient.properties.gender.enum.push('unknown');
      spec.components.schemas.Doctor = { type: 'object' };
    }),
    [],
  );
});

test('an identical contract has no breaking changes', () => {
  assert.deepEqual(findBreakingChanges(base(), base()), []);
});

const cases = [
  [
    'a removed path',
    (s) => delete s.paths['/patients/{id}'],
    /Path \/patients\/\{id\} was removed/,
  ],
  [
    'a removed operation',
    (s) => delete s.paths['/patients'].post,
    /Operation POST \/patients was removed/,
  ],
  [
    'a removed success response',
    (s) => delete s.paths['/patients'].get.responses[200],
    /Response 200 of GET \/patients was removed/,
  ],
  [
    'a removed schema',
    (s) => delete s.components.schemas.Department,
    /Schema Department was removed/,
  ],
  [
    'a removed property',
    (s) => delete s.components.schemas.Patient.properties.phone,
    /Property Patient\.phone was removed/,
  ],
  [
    'a changed type',
    (s) => (s.components.schemas.Patient.properties.id = { type: 'integer' }),
    /Patient\.id changed type from string to integer/,
  ],
  [
    'a changed array item type',
    (s) => (s.components.schemas.Patient.properties.tags.items = { type: 'integer' }),
    /Patient\.tags changed type from array<string> to array<integer>/,
  ],
  [
    'a changed reference',
    (s) =>
      (s.components.schemas.Patient.properties.department = { $ref: '#/components/schemas/Ward' }),
    /Patient\.department changed type from ref:Department to ref:Ward/,
  ],
  [
    'a property that stops being nullable',
    (s) => (s.components.schemas.Patient.properties.nickname = { type: 'string' }),
    /Patient\.nickname changed type/,
  ],
  [
    'a removed enum value',
    (s) => s.components.schemas.Patient.properties.gender.enum.pop(),
    /Value "other" was removed from Patient\.gender/,
  ],
  [
    'a property that became required',
    (s) => s.components.schemas.Patient.required.push('phone'),
    /Property Patient\.phone became required/,
  ],
  [
    'a removed nested property',
    (s) => delete s.components.schemas.Patient.properties.contact.properties.email,
    /Property Patient\.contact\.email was removed/,
  ],
  [
    'a newly required parameter',
    (s) => s.paths['/patients'].get.parameters.push({ name: 'ward', in: 'query', required: true }),
    /GET \/patients now requires the query parameter "ward"/,
  ],
];
for (const [name, mutate, expected] of cases) {
  test(`${name} is breaking`, () => {
    const found = change(mutate);
    assert.equal(found.length, 1, found.join('; '));
    assert.match(found[0], expected);
  });
}

test('removing an error response is not treated as breaking', () => {
  assert.deepEqual(
    change((spec) => delete spec.paths['/patients'].get.responses[401]),
    [],
  );
});

test('version comparison', () => {
  assert.equal(versionRaised('0.3.0', '0.3.1'), true);
  assert.equal(versionRaised('0.3.0', '0.3.0'), false);
  assert.equal(versionRaised('0.3.0', '0.2.9'), false);
  // While 0.x, a breaking change needs a minor bump. A patch bump is not enough.
  assert.equal(versionCoversBreaking('0.3.0', '0.4.0'), true);
  assert.equal(versionCoversBreaking('0.3.0', '0.3.1'), false);
  assert.equal(versionCoversBreaking('0.3.0', '1.0.0'), true);
  // From 1.0 on, only a major bump covers a breaking change.
  assert.equal(versionCoversBreaking('1.2.0', '1.3.0'), false);
  assert.equal(versionCoversBreaking('1.2.0', '2.0.0'), true);
});

function run(beforeSpec, afterSpec) {
  const beforePath = join(temp, 'before.json');
  const afterPath = join(temp, 'after.json');
  writeFileSync(beforePath, JSON.stringify(beforeSpec));
  writeFileSync(afterPath, JSON.stringify(afterSpec));
  return spawnSync(process.execPath, [script, beforePath, afterPath], { encoding: 'utf8' });
}

test('the script passes when nothing breaks', () => {
  const result = run(base(), base());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no breaking changes/);
});

test('the script fails on a breaking change without a version bump', () => {
  const next = base();
  delete next.paths['/patients/{id}'];
  const result = run(base(), next);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Path \/patients\/\{id\} was removed/);
  assert.match(result.stderr, /Raise CONTRACT_VERSION/);
});

test('the script fails when only the patch version was raised', () => {
  const next = base();
  delete next.paths['/patients/{id}'];
  next.info.version = '0.3.1';
  assert.equal(run(base(), next).status, 1);
});

test('the script accepts a breaking change with a sufficient version bump', () => {
  const next = base();
  delete next.paths['/patients/{id}'];
  next.info.version = '0.4.0';
  const result = run(base(), next);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /version was raised, so these are accepted/);
});

// --- merging the generated spec with the planned endpoints ---

const api = () => ({
  openapi: '3.1.0',
  info: { title: 'API', version: '0.1.0' },
  paths: {
    '/health': { get: { operationId: 'getHealth', responses: { 200: { description: 'ok' } } } },
  },
  components: { schemas: { Health: { type: 'object' }, Error: { type: 'object' } } },
});
const planned = () => ({
  paths: {
    '/session': {
      get: {
        operationId: 'getSession',
        responses: {
          200: {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } },
          },
          401: { $ref: '#/components/responses/Error' },
        },
      },
    },
  },
  components: {
    schemas: { Session: { type: 'object' } },
    responses: {
      Error: {
        description: 'failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
});

test('merge keeps the API spec and adds planned endpoints, marked as planned', () => {
  const merged = mergeSpecs(api(), planned());
  assert.deepEqual(Object.keys(merged.paths), ['/health', '/session']);
  assert.equal(merged.paths['/session'].get['x-planned'], true);
  assert.equal(merged.paths['/health'].get['x-planned'], undefined);
  assert.deepEqual(Object.keys(merged.components.schemas).sort(), ['Error', 'Health', 'Session']);
  assert.equal(merged.info.version, '0.1.0');
});

test('merge refuses a planned path the API now generates', () => {
  const stale = planned();
  stale.paths['/health'] = { get: { responses: {} } };
  assert.throws(() => mergeSpecs(api(), stale), /Path \/health is now generated by the API/);
});

test('merge refuses a planned schema the API now generates', () => {
  const stale = planned();
  stale.components.schemas.Health = { type: 'string' };
  assert.throws(
    () => mergeSpecs(api(), stale),
    /components\.schemas\.Health is now generated by the API/,
  );
});

test('merge refuses a reference to something neither file defines', () => {
  const broken = planned();
  delete broken.components.schemas.Session;
  assert.throws(
    () => mergeSpecs(api(), broken),
    /Reference to missing components\.schemas\.Session/,
  );
});

test('merge does not change its inputs', () => {
  const [left, right] = [api(), planned()];
  mergeSpecs(left, right);
  assert.deepEqual(left, api());
  assert.deepEqual(right, planned());
});
