import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportKind } from '../../core/imports/registry.js';
import { MemoryQueue, safeJobError } from '../../core/jobs/queue.js';
import { writeService, type NewService } from '../services/create.js';
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
import { toMinor } from './convert.js';
import { expireBatches } from './index.js';

/**
 * The import centre through the real app, database and jobs: kinds, staging, the dry run and its
 * report, writing in one transaction, the batch failing whole, patients behind their own
 * permission, one batch written at a time, the hospital boundary and the weekly expiry.
 */

let app: FastifyInstance;
let pool: pg.Pool;
const queue = new MemoryQueue();
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the import centre switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Registers patients one at a time, holds nothing of the import centre. */
let receptionist: TestUser;

/**
 * A kind whose check misses what its write then refuses: a service code already taken, as when
 * another request adds it between the check of a row and its write. The database refuses the
 * insert, which aborts the transaction.
 */
const probeKind: ImportKind<NewService> = {
  kind: 'probe_services',
  feature: 'services',
  permissions: ['service:manage'],
  body: Type.Object({ code: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  columns: [{ field: 'code', required: true, type: 'text' }],
  prepare: (_writer, body) => {
    const code = String(body.code);
    return Promise.resolve({
      value: {
        code,
        details: {
          name: `Probe ${code}`,
          category: 'consultation',
          taxClass: 'exempt',
          description: null,
        },
        today: '2026-01-01',
      },
      key: code.toLowerCase(),
    });
  },
  write: async (writer, value) => {
    await writeService(writer, value);
  },
};

const ALL = { imports: true, services: true, drugs: true, lab_tests: true, patients: true };

interface Batch {
  id: string;
  tenantId: string;
  kind: string;
  status: string;
  rowCount: number;
  doneCount: number;
  problemCount: number;
  failure?: string;
  createdBy: { id: string; name: string };
}
interface Problem {
  line: number;
  field?: string;
  code: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
const headers = ({ tenant = hospital, user = admin }: Options = {}) => as(tenant.id, user.id);
const post = (url: string, body: object | undefined, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers(options),
    ...(body ? { payload: body } : {}),
  });
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });

const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];

/** A batch of `kind` with these rows, by field, staged and not yet checked. */
async function staged(
  kind: string,
  rows: Record<string, string>[],
  options: Options = {},
): Promise<Batch> {
  const created = await post('/imports', { kind }, options);
  if (created.statusCode !== 201) throw new Error(`could not start a ${kind} batch`);
  const batch = created.json<Batch>();
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  for (let start = 0; start < rows.length; start += 1000) {
    const response = await post(
      `/imports/${batch.id}/rows`,
      {
        fields,
        rows: rows.slice(start, start + 1000).map((row, index) => ({
          line: start + index + 2,
          values: fields.map((field) => row[field] ?? ''),
        })),
      },
      options,
    );
    if (response.statusCode !== 200) throw new Error('could not stage rows');
  }
  return batch;
}

async function current(batch: Batch, options: Options = {}): Promise<Batch> {
  return (await get(`/imports/${batch.id}`, options)).json<Batch>();
}

/** Runs the dry run of a staged batch to its end. */
async function checked(batch: Batch, options: Options = {}): Promise<Batch> {
  const response = await post(`/imports/${batch.id}/check`, undefined, options);
  if (response.statusCode !== 202) throw new Error(`could not check: ${response.body}`);
  await queue.drain();
  return current(batch, options);
}

/** Writes a checked batch to its end. */
async function committed(batch: Batch, options: Options = {}): Promise<Batch> {
  const response = await post(`/imports/${batch.id}/commit`, undefined, options);
  if (response.statusCode !== 202) throw new Error(`could not commit: ${response.body}`);
  await queue.drain();
  return current(batch, options);
}

const problems = async (batch: Batch, options: Options = {}) =>
  (await get(`/imports/${batch.id}/problems?limit=100`, options)).json<{
    items: Problem[];
    total?: number;
  }>();

const stagedRows = async (batch: Batch) => {
  const { rows } = await pool.query<{ count: number }>(
    'select count(*)::int as count from import_rows where batch_id = $1',
    [batch.id],
  );
  return rows[0]?.count;
};

const service = (code: string, more: Record<string, string> = {}) => ({
  code,
  name: `Service ${code}`,
  category: 'consultation',
  taxClass: 'exempt',
  ...more,
});

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    jobQueue: queue,
    extend: (instance) => instance.importKinds.register(probeKind),
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Imports Hospital', { features: ALL });
  clinic = await createTenant(pool, 'Imports Clinic', { features: { ...ALL, drugs: false } });
  closed = await createTenant(pool, 'Imports Closed', { features: { ...ALL, imports: false } });
  const tenants = [hospital, clinic, closed];
  for (const tenant of tenants) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Imports Admin', { withPassword: false });
  receptionist = await createUser(pool, 'Imports Receptionist', { withPassword: false });
  for (const tenant of tenants) await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, receptionist, hospital, 'receptionist');
});

afterAll(async () => {
  const tenants = [hospital, clinic, closed].filter(Boolean);
  const ids = tenants.map((tenant) => tenant.id);
  try {
    for (const table of [
      'import_problems',
      'import_rows',
      'import_batches',
      'lab_tests',
      'service_prices',
      'services',
      'drugs',
      'patients',
    ]) {
      await pool.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [ids]);
    }
    await deleteUsers(pool, [admin, receptionist].filter(Boolean));
    await deleteTenants(pool, tenants);
  } finally {
    await app.close();
  }
});

describe('amounts', () => {
  it('reads the digits of an amount, grouped or not, and never through a float', () => {
    expect(toMinor('1250', 2)).toBe(125000);
    expect(toMinor('1,250.5', 2)).toBe(125050);
    expect(toMinor('1,25,000.05', 2)).toBe(12500005);
    expect(toMinor('0.07', 2)).toBe(7);
    expect(toMinor('500', 0)).toBe(500);
    expect(toMinor('12,50', 2)).toBe('not_an_amount');
    expect(toMinor('1.234', 2)).toBe('too_many_decimals');
    expect(toMinor('-5', 2)).toBe('not_an_amount');
  });
});

describe('kinds', () => {
  it('lists what the caller may load, with the fields of each', async () => {
    const response = await get('/imports/kinds');
    expect(response.statusCode).toBe(200);
    const kinds = response.json<{ items: { kind: string; columns: { field: string }[] }[] }>();
    const names = kinds.items.map((item) => item.kind).filter((kind) => kind !== 'probe_services');
    expect(names.sort()).toEqual(['drugs', 'lab_tests', 'patients', 'services']);
    const services = kinds.items.find((item) => item.kind === 'services');
    expect(services?.columns.map((column) => column.field)).toContain('priceMinor');
  });

  it('leaves out a kind whose module the hospital has off', async () => {
    const response = await get('/imports/kinds', { tenant: clinic });
    const kinds = response.json<{ items: { kind: string }[] }>().items.map((item) => item.kind);
    expect(kinds).not.toContain('drugs');
    expect(errorOf(await post('/imports', { kind: 'drugs' }, { tenant: clinic }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('is closed with the module off and to a role without the permission', async () => {
    expect(errorOf(await get('/imports/kinds', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(errorOf(await get('/imports', { user: receptionist }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await post('/imports', { kind: 'patients' }, { user: receptionist }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('refuses a kind that does not exist', async () => {
    expect(errorOf(await post('/imports', { kind: 'invoices' }))).toEqual([
      400,
      'validation_failed',
    ]);
  });
});

describe('staging rows', () => {
  it('keeps a line sent twice as it was first sent', async () => {
    const batch = await staged('services', [service('STG-1')]);
    const again = await post(`/imports/${batch.id}/rows`, {
      fields: ['code', 'name', 'category', 'taxClass'],
      rows: [{ line: 2, values: ['STG-2', 'Other', 'consultation', 'exempt'] }],
    });
    expect(again.json<Batch>().rowCount).toBe(1);
  });

  it('refuses a field the kind does not have, and a row of the wrong length', async () => {
    const batch = await staged('services', [service('STG-3')]);
    const url = `/imports/${batch.id}/rows`;
    expect(
      errorOf(await post(url, { fields: ['mrn'], rows: [{ line: 9, values: ['x'] }] })),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await post(url, { fields: ['code', 'name'], rows: [{ line: 9, values: ['x'] }] })),
    ).toEqual([400, 'validation_failed']);
  });

  it('refuses more than a thousand rows in one request', async () => {
    const batch = await staged('services', [service('STG-4')]);
    const rows = Array.from({ length: 1001 }, (_, index) => ({ line: index + 3, values: ['x'] }));
    expect(errorOf(await post(`/imports/${batch.id}/rows`, { fields: ['code'], rows }))).toEqual([
      400,
      'validation_failed',
    ]);
  });

  it('checks nothing in an empty batch, and adds nothing once checked', async () => {
    const created = (await post('/imports', { kind: 'services' })).json<Batch>();
    expect(errorOf(await post(`/imports/${created.id}/check`, undefined))).toEqual([
      409,
      'import_empty',
    ]);
    const batch = await checked(await staged('services', [service('STG-5')]));
    const late = await post(`/imports/${batch.id}/rows`, {
      fields: ['code'],
      rows: [{ line: 10, values: ['STG-6'] }],
    });
    expect(errorOf(late)).toEqual([409, 'import_not_staging']);
  });
});

describe('the dry run', () => {
  it('reports each problem by line, field and code, never the value, and writes nothing', async () => {
    await pool.query(
      `insert into drugs (tenant_id, type, generic_name, form, schedule, controlled, tax_class)
       values ($1, 'medicine', 'Existing', 'tablet', 'none', false, 'reduced')`,
      [hospital.id],
    );
    const tablet = { type: 'medicine', form: 'tablet', schedule: 'none', taxClass: 'reduced' };
    const batch = await staged('drugs', [
      { ...tablet, genericName: 'Amoxicillin', strength: '250 mg' },
      { ...tablet, genericName: '' },
      { ...tablet, genericName: 'Cetirizine', form: 'lozenge' },
      { ...tablet, genericName: 'Amoxicillin', strength: '250 MG' },
      { ...tablet, genericName: 'existing' },
      { ...tablet, genericName: 'Ibuprofen', reorderLevel: 'ten', controlled: 'maybe' },
    ]);
    const done = await checked(batch);
    expect(done).toMatchObject({ status: 'checked', rowCount: 6, doneCount: 6, problemCount: 6 });
    const report = await problems(batch);
    expect(report.total).toBe(6);
    expect(report.items).toEqual([
      { line: 3, field: 'genericName', code: 'required' },
      { line: 4, field: 'form', code: 'not_allowed' },
      { line: 5, code: 'duplicate_in_file' },
      { line: 6, code: 'drug_exists' },
      { line: 7, field: 'controlled', code: 'not_yes_or_no' },
      { line: 7, field: 'reorderLevel', code: 'not_a_whole_number' },
    ]);
    const { rows } = await pool.query(
      "select 1 from drugs where tenant_id = $1 and generic_name = 'Amoxicillin'",
      [hospital.id],
    );
    expect(rows).toHaveLength(0);
    expect(errorOf(await post(`/imports/${batch.id}/commit`, undefined))).toEqual([
      409,
      'import_not_ready',
    ]);
  });

  it('is run by one delivery of its job at a time, and taken over once that one stops', async () => {
    const batch = await staged('services', [service('CL-1')]);
    expect((await post(`/imports/${batch.id}/check`, undefined)).statusCode).toBe(202);
    // Another delivery is working on it, and said so just now.
    await pool.query(
      'update import_batches set heartbeat_at = now(), done_count = 7, claim_token = gen_random_uuid() where id = $1',
      [batch.id],
    );
    await queue.drain();
    expect(await current(batch)).toMatchObject({ status: 'checking', doneCount: 7 });

    // It stopped saying so: the next delivery takes the batch over.
    await pool.query(
      "update import_batches set heartbeat_at = now() - interval '11 minutes' where id = $1",
      [batch.id],
    );
    await queue.send('imports.check', { tenantId: hospital.id, batchId: batch.id });
    await queue.drain();
    expect(await current(batch)).toMatchObject({ status: 'checked', doneCount: 1 });
  });

  it('pages the report', async () => {
    const batch = await checked(
      await staged(
        'services',
        Array.from({ length: 30 }, () => service('', {})),
      ),
    );
    const first = (await get(`/imports/${batch.id}/problems?limit=25`)).json<{
      items: Problem[];
      nextCursor: string | null;
      total?: number;
    }>();
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(30);
    const second = (
      await get(`/imports/${batch.id}/problems?limit=25&cursor=${first.nextCursor}`)
    ).json<{ items: Problem[]; nextCursor: string | null; total?: number }>();
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBeUndefined();
    expect(second.items[4]?.line).toBe(31);
  });
});

describe('writing a batch', () => {
  it('writes every row as its create route does, audited and announced, and keeps no row', async () => {
    const batch = await checked(
      await staged('services', [
        service('WR-1', { priceMinor: '1,250.50' }),
        service('WR-2', { category: 'Procedure', description: 'Two  spaces' }),
      ]),
    );
    expect(batch.problemCount).toBe(0);
    const done = await committed(batch);
    expect(done).toMatchObject({ status: 'committed', doneCount: 2, problemCount: 0 });
    const { rows } = await pool.query<{
      id: string;
      code: string;
      category: string;
      description: string | null;
      amount: string | null;
    }>(
      `select s.id, s.code, s.category, s.description, p.amount_minor::text as amount
       from services s left join service_prices p on p.service_id = s.id
       where s.tenant_id = $1 and s.code like 'WR-%' order by s.code`,
      [hospital.id],
    );
    expect(
      rows.map(({ code, category, description, amount }) => [code, category, description, amount]),
    ).toEqual([
      ['WR-1', 'consultation', null, '125050'],
      ['WR-2', 'procedure', 'Two spaces', null],
    ]);
    const { rows: audit } = await pool.query<{ action: string; entity: string; actor_id: string }>(
      `select action, entity, actor_id from audit_log
       where tenant_id = $1 and request_id = $2 order by entity, action`,
      [hospital.id, `import:${batch.id}`],
    );
    expect(audit.map((entry) => `${entry.action} ${entry.entity}`)).toEqual([
      'check import_batch',
      'commit import_batch',
      'create service',
      'create service',
      'create service_price',
    ]);
    expect(new Set(audit.map((entry) => entry.actor_id))).toEqual(new Set([admin.id]));
    const { rows: events } = await pool.query(
      `select 1 from outbox where tenant_id = $1 and event = 'master.changed'
       and entity_id = any($2::text[])`,
      [hospital.id, rows.map((row) => row.id)],
    );
    expect(events).toHaveLength(3);
    expect(await stagedRows(batch)).toBe(0);
  });

  it('writes nothing at all when one row is refused at that moment, and reports it', async () => {
    const batch = await checked(
      await staged('services', [service('RB-1'), service('RB-2'), service('RB-3')]),
    );
    expect(batch.problemCount).toBe(0);
    // Someone adds one of the codes between the check and the commit.
    const added = await post('/services', service('rb-2'));
    expect(added.statusCode).toBe(201);
    const done = await committed(batch);
    expect(done).toMatchObject({ status: 'failed', failure: 'rows_refused', problemCount: 1 });
    expect((await problems(batch)).items).toEqual([{ line: 3, code: 'service_code_taken' }]);
    const { rows } = await pool.query(
      "select code from services where tenant_id = $1 and code in ('RB-1', 'RB-3')",
      [hospital.id],
    );
    expect(rows).toHaveLength(0);
    const { rows: audit } = await pool.query(
      `select 1 from audit_log where tenant_id = $1 and request_id = $2 and entity = 'service'`,
      [hospital.id, `import:${batch.id}`],
    );
    expect(audit).toHaveLength(0);
    expect(await stagedRows(batch)).toBe(0);
  });

  it('writes nothing when the module was switched off since', async () => {
    const batch = await checked(await staged('services', [service('PW-1')]));
    expect((await post(`/imports/${batch.id}/commit`, undefined)).statusCode).toBe(202);
    await pool.query(
      "update tenant_features set enabled = false where tenant_id = $1 and feature = 'services'",
      [hospital.id],
    );
    try {
      await queue.drain();
    } finally {
      await pool.query(
        "update tenant_features set enabled = true where tenant_id = $1 and feature = 'services'",
        [hospital.id],
      );
    }
    expect(await current(batch)).toMatchObject({
      status: 'failed',
      failure: 'permission_withdrawn',
    });
  });

  it('writes one batch at a time at a hospital, and a second delivery of the job does nothing', async () => {
    const first = await checked(await staged('services', [service('ON-1')]));
    const second = await checked(await staged('services', [service('ON-2')]));
    expect((await post(`/imports/${first.id}/commit`, undefined)).statusCode).toBe(202);
    expect(errorOf(await post(`/imports/${second.id}/commit`, undefined))).toEqual([
      409,
      'import_running',
    ]);
    expect((await current(second)).status).toBe('checked');
    await queue.drain();
    expect((await current(first)).status).toBe('committed');
    await queue.send('imports.commit', { tenantId: hospital.id, batchId: first.id });
    await queue.drain();
    const { rows } = await pool.query(
      "select 1 from services where tenant_id = $1 and code = 'ON-1'",
      [hospital.id],
    );
    expect(rows).toHaveLength(1);
    expect((await committed(second)).status).toBe('committed');
  });

  it('fails with a report, not as broken, when the database refuses a write', async () => {
    expect((await post('/services', service('PR-2'))).statusCode).toBe(201);
    const batch = await checked(
      await staged('probe_services', [{ code: 'PR-1' }, { code: 'pr-2' }, { code: 'PR-3' }]),
    );
    expect(batch.problemCount).toBe(0);
    expect(await committed(batch)).toMatchObject({
      status: 'failed',
      failure: 'rows_refused',
      problemCount: 1,
    });
    expect((await problems(batch)).items).toEqual([{ line: 3, code: 'service_code_taken' }]);
    const { rows } = await pool.query(
      "select 1 from services where tenant_id = $1 and code in ('PR-1', 'PR-3')",
      [hospital.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('writes nothing when the person lost the permission since', async () => {
    const batch = await checked(await staged('services', [service('LP-1')]));
    expect((await post(`/imports/${batch.id}/commit`, undefined)).statusCode).toBe(202);
    await pool.query(
      "delete from role_permissions where tenant_id = $1 and role_id = 'admin' and permission = 'service:manage'",
      [hospital.id],
    );
    try {
      await queue.drain();
    } finally {
      await pool.query(
        "insert into role_permissions (tenant_id, role_id, permission, scope) values ($1, 'admin', 'service:manage', 'all')",
        [hospital.id],
      );
    }
    expect(await current(batch)).toMatchObject({
      status: 'failed',
      failure: 'permission_withdrawn',
    });
    expect(await stagedRows(batch)).toBe(0);
  });

  it('gives up a batch whose job stopped, and frees the hospital to write the next', async () => {
    const stuck = await checked(await staged('services', [service('ST-1')]));
    const next = await checked(await staged('services', [service('ST-2')]));
    expect((await post(`/imports/${stuck.id}/commit`, undefined)).statusCode).toBe(202);
    // Its job never came, or died: an hour with no sign of life.
    await pool.query(
      "update import_batches set heartbeat_at = now() - interval '2 hours' where id = $1",
      [stuck.id],
    );
    expect(errorOf(await post(`/imports/${next.id}/commit`, undefined))).toEqual([
      409,
      'import_running',
    ]);
    await expireBatches(pool);
    expect(await current(stuck)).toMatchObject({ status: 'failed', failure: 'stalled' });
    expect(await stagedRows(stuck)).toBe(0);
    expect((await committed(next)).status).toBe('committed');
    const { rows } = await pool.query(
      "select 1 from services where tenant_id = $1 and code = 'ST-1'",
      [hospital.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('keeps nothing of a failed job but a code', () => {
    const refused = Object.assign(new Error('new row violates check constraint'), {
      code: '23514',
      detail: 'Failing row contains (Asha, Verma, 1990-04-12).',
    });
    const kept = safeJobError(refused);
    expect(kept.message).toBe('job_failed');
    expect(JSON.stringify({ ...kept, message: kept.message, stack: kept.stack })).not.toContain(
      'Asha',
    );
    expect((kept as Error & { code?: string }).code).toBe('23514');
  });

  it('writes ten thousand rows in one batch', { timeout: 300_000 }, async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => service(`BULK-${index}`));
    const batch = await checked(await staged('services', rows));
    expect(batch).toMatchObject({ status: 'checked', rowCount: 10_000, problemCount: 0 });
    expect(await committed(batch)).toMatchObject({ status: 'committed', doneCount: 10_000 });
    const { rows: counted } = await pool.query<{ count: number }>(
      "select count(*)::int as count from services where tenant_id = $1 and code like 'BULK-%'",
      [hospital.id],
    );
    expect(counted[0]?.count).toBe(10_000);
  });
});

describe('drugs', () => {
  it('traces an item written beside a controlled one, as adding it on its screen does', async () => {
    const controlled = await post('/drugs', {
      type: 'medicine',
      genericName: 'Codeine',
      form: 'tablet',
      strength: '30 mg',
      schedule: 'narcotic',
      taxClass: 'reduced',
    });
    expect(controlled.statusCode).toBe(201);
    const batch = await checked(
      await staged('drugs', [
        {
          type: 'Medicine',
          genericName: 'codeine',
          form: 'TABLET',
          strength: '15 mg',
          schedule: 'none',
          taxClass: 'reduced',
        },
      ]),
    );
    expect(batch.problemCount).toBe(0);
    expect((await committed(batch)).status).toBe('committed');
    const { rows } = await pool.query<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and request_id = $2 and entity = 'drug'
       order by action`,
      [hospital.id, `import:${batch.id}`],
    );
    expect(rows.map((row) => row.action)).toEqual(['beside_controlled', 'create']);
  });
});

describe('lab tests', () => {
  it('links a test to the laboratory service of the code given', async () => {
    const lab = await post('/services', service('LAB-CBC', { category: 'lab' }));
    expect(lab.statusCode).toBe(201);
    const row = {
      code: 'CBC',
      name: 'Complete blood count',
      department: 'haematology',
      sampleType: 'blood',
      turnaroundHours: '4',
    };
    const batch = await checked(
      await staged('lab_tests', [
        { ...row, serviceCode: 'lab-cbc' },
        { ...row, code: 'ESR', serviceCode: 'NOPE' },
      ]),
    );
    expect((await problems(batch)).items).toEqual([
      { line: 3, field: 'serviceCode', code: 'not_found' },
    ]);
    const fixed = await checked(await staged('lab_tests', [{ ...row, serviceCode: 'LAB-CBC' }]));
    expect((await committed(fixed)).status).toBe('committed');
    const { rows } = await pool.query<{ service_id: string; kind: string }>(
      "select service_id, kind from lab_tests where tenant_id = $1 and code = 'CBC'",
      [hospital.id],
    );
    expect(rows).toEqual([{ service_id: lab.json<{ id: string }>().id, kind: 'test' }]);
  });
});

describe('patients', () => {
  const person = {
    firstName: 'Asha',
    lastName: 'Verma',
    dob: '1990-04-12',
    gender: 'female',
    phone: '+91 98765 43210',
  };

  it('registers them with an MRN each, audited, and refuses only the same name and birth date', async () => {
    // A family shares one phone and a surname: each is registered.
    const family = [
      person,
      { ...person, firstName: 'Ravi', dob: '1985-01-01' },
      { ...person, firstName: 'Meera', dob: '2015-06-30' },
    ];
    const batch = await checked(
      await staged('patients', [
        ...family,
        { ...person, firstName: 'Bad', dob: '2999-01-01' },
        { ...person, firstName: 'Worse', phone: '12-34', email: 'no-at-sign' },
        { ...person, firstName: 'asha' },
      ]),
    );
    expect((await problems(batch)).items).toEqual([
      { line: 5, field: 'dob', code: 'out_of_range' },
      { line: 6, field: 'phone', code: 'too_few_digits' },
      { line: 7, code: 'duplicate_in_file' },
    ]);
    const good = await checked(await staged('patients', family));
    expect(good.problemCount).toBe(0);
    expect((await committed(good)).status).toBe('committed');
    const { rows } = await pool.query<{
      mrn: string;
      created_by: string;
      contact_consent_given: boolean | null;
    }>(
      `select mrn, created_by, contact_consent_given from patients
       where tenant_id = $1 order by first_name`,
      [hospital.id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => /^[A-Z0-9]+-\d{7}$/.test(row.mrn))).toBe(true);
    // Consent is not loaded from a file: it is asked of the patient.
    expect(rows.map((row) => [row.created_by, row.contact_consent_given])).toEqual([
      [admin.id, null],
      [admin.id, null],
      [admin.id, null],
    ]);
    const { rows: audit } = await pool.query<{ action: string }>(
      `select action from audit_log
       where tenant_id = $1 and request_id = $2 and entity = 'patient' order by action`,
      [hospital.id, `import:${good.id}`],
    );
    expect(audit.map((entry) => entry.action)).toEqual([
      'create',
      'create',
      'create',
      // Once for the check and once for the commit: each read the hospital's patients.
      'duplicate_check',
      'duplicate_check',
    ]);

    const again = await checked(await staged('patients', [{ ...person, firstName: 'ASHA' }]));
    expect((await problems(again)).items).toEqual([
      { line: 2, code: 'patient_possible_duplicate' },
    ]);
  });

  it('tells a registration at the desk to try again while a batch holds the MRN counter', async () => {
    const holder = await pool.connect();
    try {
      // What a batch of patients being written does from its first row to its commit.
      await holder.query('begin');
      await holder.query('select 1 from patient_mrn_counters where tenant_id = $1 for update', [
        hospital.id,
      ]);
      const started = Date.now();
      const response = await app.inject({
        method: 'POST',
        url: '/patients',
        headers: { ...headers(), 'idempotency-key': 'desk-while-importing-1' },
        payload: { ...person, firstName: 'Desk', dob: '1970-01-01' },
      });
      expect(errorOf(response)).toEqual([503, 'busy']);
      expect(response.headers['retry-after']).toBe('5');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });

  it('takes no consent from a file', async () => {
    const batch = (await post('/imports', { kind: 'patients' })).json<Batch>();
    const response = await post(`/imports/${batch.id}/rows`, {
      fields: ['contactConsent'],
      rows: [{ line: 2, values: ['yes'] }],
    });
    expect(errorOf(response)).toEqual([400, 'validation_failed']);
  });

  it('needs patient:import as well as import:run', async () => {
    await pool.query(
      `insert into role_permissions (tenant_id, role_id, permission, scope)
       values ($1, 'receptionist', 'import:run', 'all'), ($1, 'receptionist', 'import:read', 'all')`,
      [hospital.id],
    );
    try {
      const kinds = (await get('/imports/kinds', { user: receptionist })).json<{
        items: { kind: string }[];
      }>();
      expect(kinds.items.map((item) => item.kind)).not.toContain('patients');
      expect(errorOf(await post('/imports', { kind: 'patients' }, { user: receptionist }))).toEqual(
        [403, 'permission_denied'],
      );
    } finally {
      await pool.query(
        `delete from role_permissions where tenant_id = $1 and role_id = 'receptionist'
         and permission like 'import:%'`,
        [hospital.id],
      );
    }
  });
});

describe('giving up', () => {
  it('cancels a staged batch and deletes its rows; twice changes nothing', async () => {
    const batch = await staged('services', [service('CN-1')]);
    const cancelled = await post(`/imports/${batch.id}/cancel`, undefined);
    expect(cancelled.json<Batch>().status).toBe('cancelled');
    expect(await stagedRows(batch)).toBe(0);
    expect((await post(`/imports/${batch.id}/cancel`, undefined)).statusCode).toBe(200);
    expect(errorOf(await post(`/imports/${batch.id}/check`, undefined))).toEqual([
      409,
      'import_not_staging',
    ]);
  });

  it('expires a batch left unfinished for a week, at every hospital', async () => {
    const old = await staged('services', [service('EX-1')]);
    const elsewhere = await staged('services', [service('EX-2')], { tenant: clinic });
    const fresh = await staged('services', [service('EX-3')]);
    await pool.query(
      "update import_batches set created_at = now() - interval '8 days' where id = any($1::uuid[])",
      [[old.id, elsewhere.id]],
    );
    await expireBatches(pool);
    expect(await current(old)).toMatchObject({ status: 'cancelled', failure: 'expired' });
    expect(await current(elsewhere, { tenant: clinic })).toMatchObject({ status: 'cancelled' });
    expect((await current(fresh)).status).toBe('staging');
    expect(await stagedRows(old)).toBe(0);
    expect(await stagedRows(fresh)).toBe(1);
  });
});

describe('the hospital boundary', () => {
  it('answers 404 for another hospital’s batch, whatever is asked of it', async () => {
    const batch = await staged('services', [service('BD-1')]);
    const other = { tenant: clinic };
    expect(errorOf(await get(`/imports/${batch.id}`, other))).toEqual([404, 'import_not_found']);
    expect(errorOf(await get(`/imports/${batch.id}/problems`, other))).toEqual([
      404,
      'import_not_found',
    ]);
    for (const action of ['check', 'commit', 'cancel']) {
      expect(errorOf(await post(`/imports/${batch.id}/${action}`, undefined, other))).toEqual([
        404,
        'import_not_found',
      ]);
    }
    const list = (await get('/imports?limit=100', other)).json<{ items: Batch[] }>();
    expect(list.items.some((item) => item.id === batch.id)).toBe(false);
    expect(list.items.every((item) => item.tenantId === clinic.id)).toBe(true);
  });

  it('keeps every table to its hospital under the app role', async () => {
    // A batch with a problem in its report, and one still holding its rows.
    const batch = await checked(await staged('services', [service('')]));
    await staged('services', [service('BD-2')]);
    const count = (client: pg.PoolClient, table: string) =>
      client
        .query<{ count: number }>(
          `select count(*)::int as count from ${table} where tenant_id = $1`,
          [hospital.id],
        )
        .then(({ rows }) => rows[0]?.count);
    const tables = ['import_batches', 'import_rows', 'import_problems'];
    const own = await asTenantSql(pool, hospital.id, async (client) =>
      Promise.all(tables.map((table) => count(client, table))),
    );
    expect(own.every((value) => (value ?? 0) > 0)).toBe(true);
    const seen = await asTenantSql(pool, clinic.id, async (client) =>
      Promise.all(tables.map((table) => count(client, table))),
    );
    expect(seen).toEqual([0, 0, 0]);
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into import_rows (tenant_id, batch_id, line, "values") values ($1, $2, 99, '{}')`,
          [hospital.id, batch.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lists the hospital’s batches newest first, by cursor', async () => {
    const page = (await get('/imports?limit=2')).json<{
      items: Batch[];
      nextCursor: string | null;
    }>();
    expect(page.items).toHaveLength(2);
    const next = (await get(`/imports?limit=2&cursor=${page.nextCursor}`)).json<{
      items: Batch[];
    }>();
    expect(next.items[0]?.id).not.toBe(page.items[1]?.id);
    expect(page.items[0]?.createdBy).toEqual({ id: admin.id, name: 'Imports Admin' });
    expect(errorOf(await get('/imports?cursor=nonsense'))).toEqual([400, 'invalid_cursor']);
  });
});
