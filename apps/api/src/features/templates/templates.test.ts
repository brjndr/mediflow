import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
  asTenantSql,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  grantRoleDefaults,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';

/**
 * The templates API through the real app and database: adding a template, saving versions that
 * are never changed, the placeholders of each kind, archiving, the redaction of an older version,
 * the hospital boundary and permissions.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the templates module switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Reads templates, changes none. */
let doctor: TestUser;
/** No template permissions at all. */
let receptionist: TestUser;
/** A role the hospital made: it keeps the templates and may not redact. */
let editor: TestUser;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Template {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  version: number;
  savedAt: string;
  archived: boolean;
}
interface VersionInfo {
  version: number;
  savedAt: string;
  savedByName: string;
  redactedAt?: string;
}
interface Detail {
  template: Template;
  body: unknown;
  versions: VersionInfo[];
}
interface Version extends VersionInfo {
  name: string;
  body: unknown;
  redactedByName?: string;
  redactionReason?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const doc = (...lines: string[]) => ({
  type: 'doc',
  content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
});
const EMPTY = { type: 'doc', content: [] };

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
const call = (method: 'GET' | 'POST' | 'PUT', url: string, options: Options, payload?: object) =>
  app.inject({ method, url, headers: headers(options), ...(payload ? { payload } : {}) });

const add = (body: object, options: Options = {}) =>
  call('POST', '/templates', options, {
    kind: 'prescription',
    body: doc('Rx for {{patient.name}}'),
    ...body,
  });
const read = (id: string, options: Options = {}) => call('GET', `/templates/${id}`, options);
const save = (id: string, body: object, options: Options = {}) =>
  call('PUT', `/templates/${id}`, options, body);
const version = (id: string, n: number | string, options: Options = {}) =>
  call('GET', `/templates/${id}/versions/${n}`, options);
const redact = (id: string, n: number | string, options: Options = {}, reason = 'patient_data') =>
  call('POST', `/templates/${id}/versions/${n}/redact`, options, { reason });
const list = (query = '', options: Options = {}) => call('GET', `/templates${query}`, options);
const archive = (id: string, options: Options = {}) =>
  call('POST', `/templates/${id}/archive`, options);
const restore = (id: string, options: Options = {}) =>
  call('POST', `/templates/${id}/restore`, options);

const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];

/** A new template of the hospital, with a name of its own. */
async function added(name: string, body: object = {}, options: Options = {}): Promise<Detail> {
  const response = await add({ name, ...body }, options);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Detail>();
}

const auditOf = async (id: string, tenant = hospital) =>
  (
    await pool.query<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and entity = 'template' and entity_id = $2 order by at`,
      [tenant.id, id],
    )
  ).rows.map((row) => row.action);

const eventsOf = async (id: string) =>
  (
    await pool.query<{ payload: unknown }>(
      `select payload from outbox where tenant_id = $1 and event = 'master.changed' and entity_id = $2 order by occurred_at, id`,
      [hospital.id, id],
    )
  ).rows.map((row) => row.payload);

const cleanUp = async (tenants: TestTenant[]) => {
  const ids = tenants.map((tenant) => tenant.id);
  await pool.query('delete from template_versions where tenant_id = any($1)', [ids]);
  await pool.query('delete from templates where tenant_id = any($1)', [ids]);
  await deleteTenants(pool, tenants);
};

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Templates Hospital', { features: { templates: true } });
  clinic = await createTenant(pool, 'Templates Clinic', { features: { templates: true } });
  closed = await createTenant(pool, 'Templates Closed', { features: { templates: false } });
  const tenants = [hospital, clinic, closed];
  for (const tenant of tenants) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Templates Admin', { withPassword: false });
  doctor = await createUser(pool, 'Templates Doctor', { withPassword: false });
  receptionist = await createUser(pool, 'Templates Desk', { withPassword: false });
  editor = await createUser(pool, 'Templates Editor', { withPassword: false });
  for (const tenant of tenants) await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await pool.query(
    "insert into roles (tenant_id, id, name) values ($1, 'template_editor', 'Template editor')",
    [hospital.id],
  );
  await pool.query(
    `insert into role_permissions (tenant_id, role_id, permission)
     values ($1, 'template_editor', 'template:read'), ($1, 'template_editor', 'template:manage')`,
    [hospital.id],
  );
  await addMembership(pool, editor, hospital, 'template_editor');
});

afterAll(async () => {
  try {
    await cleanUp([hospital, clinic, closed].filter(Boolean));
    await deleteUsers(pool, [admin, doctor, receptionist, editor].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('adding a template', () => {
  it('adds it to the session’s hospital as version 1, tidied, and records who did', async () => {
    const response = await add({
      name: '  Standard   prescription ',
      body: doc('{{hospital.name}}', 'Rx for {{ patient.name }}'),
      tenantId: clinic.id,
      id: randomUUID(),
    });
    expect(response.statusCode).toBe(201);
    const detail = response.json<Detail>();
    expect(detail).toEqual({
      template: {
        id: detail.template.id,
        tenantId: hospital.id,
        kind: 'prescription',
        name: 'Standard prescription',
        version: 1,
        savedAt: detail.template.savedAt,
        archived: false,
      },
      body: doc('{{hospital.name}}', 'Rx for {{ patient.name }}'),
      versions: [{ version: 1, savedAt: detail.template.savedAt, savedByName: 'Templates Admin' }],
    });
    expect(await auditOf(detail.template.id)).toEqual(['create']);
    expect(await eventsOf(detail.template.id)).toEqual([{ kind: 'template', change: 'created' }]);
    const again = await read(detail.template.id);
    expect(again.json()).toEqual(detail);
    // A template's text is kept by no cache: a copy there is one no redaction reaches.
    for (const answer of [response, again, await list(), await version(detail.template.id, 1)]) {
      expect(answer.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('keeps of the text only what a document may hold', async () => {
    const detail = await added('Reduced', {
      body: {
        type: 'doc',
        content: [
          { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
          {
            type: 'paragraph',
            style: 'x',
            content: [
              {
                type: 'text',
                text: '<img src=x> {{doctor.name}}',
                marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'javascript:1' } }],
              },
            ],
          },
        ],
      },
    });
    expect(detail.body).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<img src=x> {{doctor.name}}', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
  });

  it('refuses a name another template of the kind has, whatever its capitals, archived or not', async () => {
    const first = await added('Consent for surgery', { kind: 'consent' });
    expect(errorOf(await add({ name: 'consent FOR surgery', kind: 'consent' }))).toEqual([
      409,
      'template_name_taken',
    ]);
    await archive(first.template.id);
    expect(errorOf(await add({ name: 'Consent for surgery', kind: 'consent' }))).toEqual([
      409,
      'template_name_taken',
    ]);
    // Another kind is another list of names, and so is another hospital.
    await added('Consent for surgery', { kind: 'clinical_note' });
    await added('Consent for surgery', { kind: 'consent' }, { tenant: clinic });
  });

  it('lets one of two requests for the same new name through', async () => {
    const responses = await Promise.all([
      add({ name: 'Raced', kind: 'clinical_note' }),
      add({ name: 'raced', kind: 'clinical_note' }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('knows the placeholders of each kind, and refuses any other', async () => {
    const withPlaceholder = (kind: string, name: string) =>
      add({ kind, name: `${kind} ${name}`, body: doc(`Text {{${name}}}`) });
    expect((await withPlaceholder('consent', 'procedure.name')).statusCode).toBe(201);
    expect((await withPlaceholder('discharge_summary', 'discharge.date')).statusCode).toBe(201);
    expect((await withPlaceholder('clinical_note', 'date.today')).statusCode).toBe(201);
    for (const [kind, name] of [
      ['prescription', 'procedure.name'],
      ['consent', 'discharge.date'],
      ['clinical_note', 'made.up'],
      ['prescription', 'constructor'],
      ['prescription', ''],
    ] as const) {
      const response = await withPlaceholder(kind, name);
      expect(errorOf(response), `${kind} ${name}`).toEqual([400, 'validation_failed']);
      // What was typed is not repeated in the answer.
      expect(response.body).not.toContain('made.up');
    }
  });

  it('refuses what is not a template', async () => {
    const bad: object[] = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 'Nul\u0000name' },
      { name: 'Over‮ride' },
      { name: 7 },
      { name: 'No kind', kind: 'letter' },
      { name: 'Empty text', body: EMPTY },
      { name: 'Blank text', body: doc('   ') },
      { name: 'Only markup', body: { type: 'doc', content: [{ type: 'script' }] } },
      { name: 'Not a document', body: 'Rx' },
      { name: 'A list', body: [doc('Rx')] },
      { name: 'Nul text', body: doc('Rx\u0000') },
      { name: 'Half a pair', body: doc('Rx \ud83d') },
    ];
    for (const body of bad) {
      expect(errorOf(await add(body)), JSON.stringify(body)).toEqual([400, 'validation_failed']);
    }
    expect(
      (await call('POST', '/templates', {}, { name: 'No text', kind: 'consent' })).statusCode,
    ).toBe(400);
  });

  it('adds nothing twice for one Idempotency-Key, and keeps nothing of the text for a repeat', async () => {
    const key = `tpl-${randomUUID()}`;
    const body = { name: 'Asked twice', kind: 'clinical_note', body: doc('Complaints', 'Plan') };
    const first = await add(body, { key });
    expect(first.statusCode).toBe(201);
    const again = await add(body, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const id = first.json<Detail>().template.id;
    expect(await auditOf(id)).toEqual(['create']);
    const stored = await pool.query<{ response_body: unknown }>(
      'select response_body from idempotency_keys where tenant_id = $1 and key = $2',
      [hospital.id, key],
    );
    // Of the answer, the id of the template and nothing else: no name and no text.
    expect(stored.rows).toEqual([{ response_body: { id } }]);
    // The same key with another request is refused.
    expect(errorOf(await add({ ...body, name: 'Another' }, { key }))).toEqual([
      422,
      'idempotency_key_reuse',
    ]);
    // A repeat is answered with the template as it is now: found by its id, so also once it
    // has another name, another template has the name it was added with, and it is archived.
    await save(id, { name: 'Asked twice, renamed', expectedVersion: 1 });
    const other = await added('Asked twice', { kind: 'clinical_note' });
    await archive(id);
    const later = await add(body, { key });
    expect(later.statusCode).toBe(201);
    expect(later.json<Detail>().template).toMatchObject({
      id,
      name: 'Asked twice, renamed',
      version: 2,
      archived: true,
    });
    expect(other.template.id).not.toBe(id);
  });

  it('refuses a text nested too deep to be written out again, with or without a key', async () => {
    // Written as text: a document this deep cannot be written out by the test either.
    const levels = 30_000;
    const payload =
      '{"kind":"prescription","name":"Too deep","body":{"type":"doc","content":[' +
      '{"type":"paragraph","content":['.repeat(levels) +
      '{"type":"text","text":"x"}' +
      ']}'.repeat(levels) +
      ']}}';
    const send = (key?: string) =>
      app.inject({
        method: 'POST',
        url: '/templates',
        headers: { ...headers({ key }), 'content-type': 'application/json' },
        payload,
      });
    expect(errorOf(await send(`tpl-${randomUUID()}`))).toEqual([400, 'validation_failed']);
    expect(errorOf(await send())).toEqual([400, 'validation_failed']);
  });
});

describe('saving a version', () => {
  it('adds the next version and leaves the ones before it as they were', async () => {
    const { template } = await added('Discharge', {
      kind: 'discharge_summary',
      body: doc('Patient: {{patient.name}}'),
    });
    const second = await save(
      template.id,
      {
        body: doc('Patient: {{patient.name}}', 'Discharged {{discharge.date}}'),
        expectedVersion: 1,
      },
      { user: editor },
    );
    expect(second.statusCode).toBe(200);
    const third = await save(template.id, { name: 'Discharge summary', expectedVersion: 2 });
    const detail = third.json<Detail>();
    expect(detail.template).toMatchObject({ name: 'Discharge summary', version: 3 });
    expect(detail.body).toEqual(doc('Patient: {{patient.name}}', 'Discharged {{discharge.date}}'));
    expect(detail.versions.map((each) => [each.version, each.savedByName])).toEqual([
      [3, 'Templates Admin'],
      [2, 'Templates Editor'],
      [1, 'Templates Admin'],
    ]);
    expect((await version(template.id, 1)).json()).toMatchObject({
      version: 1,
      name: 'Discharge',
      body: doc('Patient: {{patient.name}}'),
      savedByName: 'Templates Admin',
    });
    expect((await version(template.id, 2)).json<Version>().name).toBe('Discharge');
    expect((await version(template.id, 3)).json<Version>().name).toBe('Discharge summary');
    expect(await auditOf(template.id)).toEqual(['create', 'update', 'update']);
    expect(await eventsOf(template.id)).toEqual([
      { kind: 'template', change: 'created' },
      { kind: 'template', change: 'updated', fields: ['body'], version: 2 },
      { kind: 'template', change: 'updated', fields: ['name'], version: 3 },
    ]);
    expect(errorOf(await version(template.id, 4))).toEqual([404, 'template_version_not_found']);
    expect(errorOf(await version(template.id, 2_147_483_647))).toEqual([
      404,
      'template_version_not_found',
    ]);
    expect((await version(template.id, 2_147_483_648)).statusCode).toBe(400);
    expect((await version(template.id, 0)).statusCode).toBe(400);
    expect((await version(template.id, 'one')).statusCode).toBe(400);
  });

  it('makes no version of what the newest already has', async () => {
    const { template } = await added('Unchanged', { body: doc('Rx', 'Date: {{date.today}}') });
    const response = await save(template.id, {
      name: ' Unchanged ',
      body: doc('Rx', 'Date: {{date.today}}'),
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Detail>().template.version).toBe(1);
    expect((await save(template.id, { expectedVersion: 1 })).json<Detail>().versions).toHaveLength(
      1,
    );
    expect(await auditOf(template.id)).toEqual(['create']);
  });

  it('knows the same text however the database gives it back', async () => {
    // Every kind of node, with its keys in the order the app writes them, which is not the
    // order a stored document comes back in.
    const rich = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Advice' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Take ', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'hardBreak' },
            { type: 'text', text: '{{patient.name}}' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rest' }] }],
            },
          ],
        },
        { type: 'paragraph' },
      ],
    };
    const { template, body } = await added('Rich text', { body: rich });
    expect(body).toEqual(rich);
    const same = await save(template.id, { body: rich, expectedVersion: 1 });
    expect(same.json<Detail>().template.version).toBe(1);
    // One mark fewer is another text.
    const changed = JSON.parse(
      JSON.stringify(rich).replace(',{"type":"italic"}', ''),
    ) as typeof rich;
    expect(changed).not.toEqual(rich);
    expect(
      (await save(template.id, { body: changed, expectedVersion: 1 })).json<Detail>().template
        .version,
    ).toBe(2);
  });

  it('keeps the last of its 500 versions for whoever may redact, so a correction is always possible', async () => {
    const { template } = await added('Many versions');
    // 498 more versions, written as the owner: each is the next number, then the template's.
    await pool.query(
      `do $$
       declare n integer;
       begin
         for n in 2..499 loop
           insert into template_versions (tenant_id, template_id, version, name, body, saved_at, saved_by)
             values ('${hospital.id}', '${template.id}', n, 'Many versions', '{"type": "doc", "content": []}', now(), '${admin.id}');
           update templates set version = n, saved_at = now() where id = '${template.id}';
         end loop;
       end $$`,
    );
    const last = { body: doc('Typed by mistake'), expectedVersion: 499 };
    expect(errorOf(await save(template.id, last, { user: editor }))).toEqual([
      409,
      'template_version_limit',
    ]);
    expect((await save(template.id, last)).json<Detail>().template.version).toBe(500);
    expect(errorOf(await save(template.id, { body: doc('More'), expectedVersion: 500 }))).toEqual([
      409,
      'template_version_limit',
    ]);
    // What the one before it held can still be removed.
    expect((await redact(template.id, 499)).statusCode).toBe(200);
    expect((await read(template.id)).json<Detail>().versions).toHaveLength(500);
    expect(errorOf(await version(template.id, 501))).toEqual([404, 'template_version_not_found']);
  });

  it('refuses a save made from a version that is no longer the newest, and of two at once lets one through', async () => {
    const { template } = await added('Conflict');
    await save(template.id, { body: doc('Theirs'), expectedVersion: 1 });
    expect(errorOf(await save(template.id, { body: doc('Mine'), expectedVersion: 1 }))).toEqual([
      409,
      'conflict',
    ]);
    // Theirs stays in the history, and saving again from it makes mine the newest.
    expect((await save(template.id, { body: doc('Mine'), expectedVersion: 2 })).statusCode).toBe(
      200,
    );
    const responses = await Promise.all([
      save(template.id, { body: doc('One'), expectedVersion: 3 }),
      save(template.id, { body: doc('Two'), expectedVersion: 3 }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await read(template.id)).json<Detail>().template.version).toBe(4);
  });

  it('checks the name and the text as for a new template, and never changes the kind', async () => {
    const { template } = await added('Checked');
    await added('Checked already');
    const bad: [object, [number, string]][] = [
      [{ name: 'checked ALREADY' }, [409, 'template_name_taken']],
      [{ name: '  ' }, [400, 'validation_failed']],
      [{ body: EMPTY }, [400, 'validation_failed']],
      [{ body: doc('{{discharge.date}}') }, [400, 'validation_failed']],
      [{ body: doc('Rx\u0000') }, [400, 'validation_failed']],
    ];
    for (const [body, expected] of bad) {
      expect(errorOf(await save(template.id, { ...body, expectedVersion: 1 }))).toEqual(expected);
    }
    expect((await save(template.id, { body: doc('Rx') })).statusCode).toBe(400);
    // A kind in the request is not read.
    const response = await save(template.id, {
      kind: 'consent',
      name: 'Checked',
      expectedVersion: 1,
    });
    expect(response.json<Detail>().template).toMatchObject({ kind: 'prescription', version: 1 });
    // Its own name in other capitals is a change of name, not a name that is taken.
    expect(
      (await save(template.id, { name: 'CHECKED', expectedVersion: 1 })).json<Detail>().template,
    ).toMatchObject({ name: 'CHECKED', version: 2 });
  });

  it('answers 404 for a template that does not exist', async () => {
    for (const id of [randomUUID(), 'not-an-id']) {
      expect(errorOf(await read(id))).toEqual([404, 'template_not_found']);
      expect(errorOf(await save(id, { name: 'x', expectedVersion: 1 }))).toEqual([
        404,
        'template_not_found',
      ]);
      expect(errorOf(await version(id, 1))).toEqual([404, 'template_not_found']);
      expect(errorOf(await archive(id))).toEqual([404, 'template_not_found']);
      expect(errorOf(await redact(id, 1))).toEqual([404, 'template_not_found']);
    }
  });
});

describe('archiving', () => {
  it('takes a template out of use and brings it back, without making a version', async () => {
    const { template } = await added('Archived one', { kind: 'consent' });
    const response = await archive(template.id);
    expect(response.json<Detail>().template).toMatchObject({ archived: true, version: 1 });
    expect((await archive(template.id)).statusCode).toBe(200);
    // Read-only until it is restored.
    expect(errorOf(await save(template.id, { name: 'Renamed', expectedVersion: 1 }))).toEqual([
      409,
      'template_archived',
    ]);
    expect((await read(template.id)).json<Detail>().template.archived).toBe(true);
    expect((await restore(template.id)).json<Detail>().template.archived).toBe(false);
    expect((await restore(template.id)).statusCode).toBe(200);
    expect((await save(template.id, { name: 'Renamed', expectedVersion: 1 })).statusCode).toBe(200);
    expect(await auditOf(template.id)).toEqual(['create', 'archive', 'restore', 'update']);
    expect((await eventsOf(template.id)).slice(1, 3)).toEqual([
      { kind: 'template', change: 'archived' },
      { kind: 'template', change: 'restored' },
    ]);
  });
});

describe('the list', () => {
  it('gives the templates in use by name, a page at a time, by kind, and the archived ones apart', async () => {
    const names = (response: Response) =>
      response.json<{ items: Template[] }>().items.map((item) => item.name);
    for (const name of ['beta note', 'Alpha note', 'Gamma note', 'alpha Note 2']) {
      await added(name, { kind: 'clinical_note' }, { tenant: clinic });
    }
    const old = await added('Delta note', { kind: 'clinical_note' }, { tenant: clinic });
    await archive(old.template.id, { tenant: clinic });

    const first = await list('?kind=clinical_note&limit=2', { tenant: clinic });
    expect(first.statusCode).toBe(200);
    expect(names(first)).toEqual(['Alpha note', 'alpha Note 2']);
    const page = first.json<{ nextCursor: string; total?: number }>();
    expect(page.total).toBe(4);
    const second = await list(`?kind=clinical_note&limit=2&cursor=${page.nextCursor}`, {
      tenant: clinic,
    });
    expect(names(second)).toEqual(['beta note', 'Gamma note']);
    expect(second.json<{ nextCursor: string | null; total?: number }>()).toMatchObject({
      nextCursor: null,
    });
    expect(second.json<{ total?: number }>().total).toBeUndefined();
    expect(names(await list('?archived=true', { tenant: clinic }))).toEqual(['Delta note']);
    // Every kind, the consent form of the clinic among them.
    expect(names(await list('', { tenant: clinic }))).toContain('Consent for surgery');
    expect(names(await list('?kind=prescription', { tenant: clinic }))).toEqual([]);
    expect((await list('?kind=letter')).statusCode).toBe(400);
    expect((await list('?limit=101')).statusCode).toBe(400);
    expect(errorOf(await list('?cursor=made-up'))).toEqual([400, 'invalid_cursor']);
  });
});

describe('redacting a version', () => {
  it('removes the name and the text of an older version, and keeps who saved it and who removed it', async () => {
    const { template } = await added('Summary of Asha Rao', {
      kind: 'discharge_summary',
      body: doc('Asha Rao, admitted with chest pain'),
    });
    // The newest version is the template as it is used: a corrected one comes first.
    expect(errorOf(await redact(template.id, 1))).toEqual([409, 'template_version_current']);
    await save(
      template.id,
      { name: 'Summary', body: doc('Patient: {{patient.name}}'), expectedVersion: 1 },
      { user: editor },
    );

    const response = await redact(template.id, 1);
    expect(response.statusCode).toBe(200);
    const detail = response.json<Detail>();
    expect(detail.template).toMatchObject({ name: 'Summary', version: 2 });
    expect(detail.body).toEqual(doc('Patient: {{patient.name}}'));
    expect(detail.versions.map((each) => [each.version, Boolean(each.redactedAt)])).toEqual([
      [2, false],
      [1, true],
    ]);
    const gone = (await version(template.id, 1)).json<Version>();
    expect(gone).toEqual({
      version: 1,
      savedAt: gone.savedAt,
      savedByName: 'Templates Admin',
      name: '',
      body: EMPTY,
      redactedAt: gone.redactedAt,
      redactedByName: 'Templates Admin',
      redactionReason: 'patient_data',
    });
    // Nothing of it is left anywhere a request, the log of changes or an event can reach.
    const left = await pool.query<{ rest: string }>(
      `select (select string_agg(name || body::text, ' ') from template_versions where template_id = $1::uuid)
              || coalesce((select string_agg(payload::text, ' ') from outbox where entity_id = ($1::uuid)::text), '')
              || (select name from templates where id = $1::uuid) as rest`,
      [template.id],
    );
    expect(left.rows[0]?.rest).not.toMatch(/Asha|chest/);
    expect(await auditOf(template.id)).toEqual(['create', 'update', 'redact']);
    expect((await eventsOf(template.id)).at(-1)).toEqual({
      kind: 'template_version',
      change: 'redacted',
      version: 1,
      reason: 'patient_data',
    });

    // Twice changes nothing, and says nothing again.
    const again = await redact(template.id, 1, {}, 'other');
    expect(again.statusCode).toBe(200);
    expect((await version(template.id, 1)).json<Version>().redactionReason).toBe('patient_data');
    expect(await auditOf(template.id)).toEqual(['create', 'update', 'redact']);
    // The template goes on as before.
    expect((await save(template.id, { body: doc('Patient'), expectedVersion: 2 })).statusCode).toBe(
      200,
    );
  });

  it('is refused for a version there never was, and for a reason not on the list', async () => {
    const { template } = await added('Redaction checks');
    await save(template.id, { body: doc('Second'), expectedVersion: 1 });
    expect(errorOf(await redact(template.id, 3))).toEqual([404, 'template_version_not_found']);
    expect((await redact(template.id, 1, {}, 'Asha Rao asked')).statusCode).toBe(400);
    expect((await call('POST', `/templates/${template.id}/versions/1/redact`, {})).statusCode).toBe(
      400,
    );
    expect((await version(template.id, 1)).json<Version>().name).toBe('Redaction checks');
  });

  it('needs its own permission: keeping the templates is not enough', async () => {
    const { template } = await added('Redaction access');
    await save(template.id, { body: doc('Second'), expectedVersion: 1 });
    for (const user of [editor, doctor]) {
      expect(errorOf(await redact(template.id, 1, { user }))).toEqual([403, 'permission_denied']);
    }
    expect((await version(template.id, 1)).json<Version>().redactedAt).toBeUndefined();
    // An archived template's older versions can still be redacted.
    await archive(template.id);
    expect((await redact(template.id, 1)).statusCode).toBe(200);
  });
});

describe('access', () => {
  it('lets someone who may only read see templates and versions and change nothing', async () => {
    const { template } = await added('Read only');
    const options = { user: doctor };
    expect((await list('', options)).statusCode).toBe(200);
    expect((await read(template.id, options)).statusCode).toBe(200);
    expect((await version(template.id, 1, options)).statusCode).toBe(200);
    for (const response of [
      await add({ name: 'By a doctor' }, options),
      await save(template.id, { name: 'x', expectedVersion: 1 }, options),
      await archive(template.id, options),
      await restore(template.id, options),
    ]) {
      expect(errorOf(response)).toEqual([403, 'permission_denied']);
    }
  });

  it('shows nothing to a role without the permission', async () => {
    const options = { user: receptionist };
    expect(errorOf(await list('', options))).toEqual([403, 'permission_denied']);
    expect(errorOf(await add({ name: 'By the desk' }, options))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('does not exist for a hospital with the module off', async () => {
    const options = { tenant: closed };
    expect(errorOf(await list('', options))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await add({ name: 'Closed' }, options))).toEqual([403, 'feature_disabled']);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/templates' })).statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('never see or change each other’s templates', async () => {
    const { template } = await added('Ours alone', { body: doc('First') });
    await save(template.id, { body: doc('Second'), expectedVersion: 1 });
    const theirs = { tenant: clinic };
    expect(errorOf(await read(template.id, theirs))).toEqual([404, 'template_not_found']);
    expect(errorOf(await version(template.id, 1, theirs))).toEqual([404, 'template_not_found']);
    expect(errorOf(await save(template.id, { name: 'x', expectedVersion: 2 }, theirs))).toEqual([
      404,
      'template_not_found',
    ]);
    expect(errorOf(await archive(template.id, theirs))).toEqual([404, 'template_not_found']);
    expect(errorOf(await redact(template.id, 1, theirs))).toEqual([404, 'template_not_found']);
    const names = (await list('?limit=100', theirs))
      .json<{ items: Template[] }>()
      .items.map((item) => item.name);
    expect(names).not.toContain('Ours alone');
    expect((await read(template.id)).json<Detail>().template).toMatchObject({
      version: 2,
      archived: false,
    });

    const seen = await asTenantSql(pool, clinic.id, async (client) => ({
      templates: (await client.query('select 1 from templates where id = $1', [template.id]))
        .rowCount,
      versions: (
        await client.query('select 1 from template_versions where template_id = $1', [template.id])
      ).rowCount,
      changed: (
        await client.query('update templates set archived = true where id = $1', [template.id])
      ).rowCount,
    }));
    expect(seen).toEqual({ templates: 0, versions: 0, changed: 0 });
    // A version cannot be put into another hospital's template.
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into template_versions (tenant_id, template_id, version, name, body, saved_by)
           values ($1, $2, 1, 'Planted', '{"type": "doc", "content": []}', $3)`,
          [hospital.id, template.id, admin.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('the database', () => {
  it('lets nothing of a saved version change, except to redact an older one once', async () => {
    const { template } = await added('Guarded', { body: doc('First') });
    await save(template.id, { body: doc('Second'), expectedVersion: 1 });
    const sql = (text: string, params: unknown[] = []) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text, [template.id, ...params]));

    // The app role may write only what a redaction writes, and may delete nothing.
    for (const statement of [
      'update template_versions set saved_at = now() where template_id = $1',
      'update template_versions set version = 9 where template_id = $1 and version = 1',
      'delete from template_versions where template_id = $1',
      'delete from templates where id = $1',
    ]) {
      await expect(sql(statement), statement).rejects.toThrow(/permission denied/);
    }
    // A change of the text alone is not a redaction, and the newest version is never redacted.
    await expect(
      sql(
        `update template_versions set body = '{"type": "doc", "content": []}' where template_id = $1 and version = 1`,
      ),
    ).rejects.toThrow(/never changed/);
    await expect(
      sql(
        `update template_versions set name = '', body = '{"type": "doc", "content": []}',
           redacted_at = now(), redacted_by = $2, redaction_reason = 'other'
         where template_id = $1 and version = 2`,
        [admin.id],
      ),
    ).rejects.toThrow(/newest version/);
    // A redaction that leaves the text is refused by the table itself.
    await expect(
      sql(
        `update template_versions set redacted_at = now(), redacted_by = $2, redaction_reason = 'other'
         where template_id = $1 and version = 1`,
        [admin.id],
      ),
    ).rejects.toThrow(/template_versions_redaction/);
    // A version is the next number, and a template is named and numbered by its newest version.
    await expect(
      sql(
        `insert into template_versions (tenant_id, template_id, version, name, body, saved_by)
         values (app_tenant_id(), $1, 5, 'Skipped', '{"type": "doc", "content": []}', $2)`,
        [admin.id],
      ),
    ).rejects.toThrow(/next number/);
    for (const statement of [
      "update templates set name = 'Renamed' where id = $1",
      'update templates set version = 3 where id = $1',
      "update templates set kind = 'consent' where id = $1",
    ]) {
      await expect(sql(statement), statement).rejects.toThrow(/newest version|keeps its hospital/);
    }
    // The owner is held to the same: the trigger does not ask who is asking.
    await expect(
      pool.query("update template_versions set name = 'Edited' where template_id = $1", [
        template.id,
      ]),
    ).rejects.toThrow(/never changed/);

    // A template is added as its version 1, and a redaction is dated by the database.
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query(
          "insert into templates (tenant_id, kind, name, version) values (app_tenant_id(), 'consent', 'Planted at seven', 7)",
        ),
      ),
    ).rejects.toThrow(/added as its version 1/);
    const backdated = await asTenantSql(pool, hospital.id, async (client) => {
      await client.query(
        `update template_versions set name = '', body = '{"type": "doc", "content": []}',
           redacted_at = '2001-01-01', redacted_by = $2, redaction_reason = 'other'
         where template_id = $1 and version = 1`,
        [template.id, admin.id],
      );
      const { rows } = await client.query<{ recent: boolean }>(
        "select redacted_at > now() - interval '1 hour' as recent from template_versions where template_id = $1 and version = 1",
        [template.id],
      );
      return rows[0]?.recent;
    });
    expect(backdated).toBe(true);

    await redact(template.id, 1);
    await expect(
      sql(
        `update template_versions set redaction_reason = 'confidential' where template_id = $1 and version = 1`,
      ),
    ).rejects.toThrow(/never changed/);
  });
});
