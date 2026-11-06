import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
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
 * Prescription sets and favourite medicines through the real app and database: own and shared
 * sets, the 30-line limit, an archived medicine, the hospital boundary and permissions.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let otherDoctor: TestUser;
let nurse: TestUser;
let receptionist: TestUser;
/** A role the hospital made: it keeps its own sets and shares none. */
let custom: TestUser;
const drugs: Record<string, string> = {};
let clinicDrug: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Detail {
  set: {
    id: string;
    tenantId: string;
    name: string;
    shared: boolean;
    lineCount: number;
    archived: boolean;
    version: number;
  };
  lines: { drugId: string; drugName: string; drugArchived: boolean; dose: string }[];
}

const line = (drugId: string, extra: object = {}) => ({
  drugId,
  dose: '500 mg',
  route: 'oral',
  frequency: '1-0-1',
  durationDays: 5,
  ...extra,
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  { tenant = hospital, user = doctor, key }: Options = {},
  payload?: object,
) =>
  app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  });

const create = (body: object, options: Options = {}) =>
  call('POST', '/prescription-sets', options, {
    name: 'Fever',
    lines: [line(drugs.para!)],
    ...body,
  });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
async function added(body: object = {}, options: Options = {}): Promise<Detail> {
  const response = await create(body, options);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Detail>();
}

const drug = async (tenant: TestTenant, name: string, archived = false) =>
  (
    await pool.query<{ id: string }>(
      `insert into drugs (tenant_id, type, generic_name, form, strength, schedule, tax_class, archived)
       values ($1, 'medicine', $2, 'tablet', '500 mg', 'none', 'exempt', $3) returning id`,
      [tenant.id, name, archived],
    )
  ).rows[0]!.id;

const cleanUp = async () => {
  const ids = [hospital, clinic, closed].map((tenant) => tenant.id);
  await pool.query('delete from doctor_favourite_drugs where tenant_id = any($1)', [ids]);
  await pool.query('delete from prescription_set_lines where tenant_id = any($1)', [ids]);
  await pool.query('delete from prescription_sets where tenant_id = any($1)', [ids]);
  await pool.query('delete from drugs where tenant_id = any($1)', [ids]);
};

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Sets Hospital', { features: { clinical: true } });
  clinic = await createTenant(pool, 'Sets Clinic', { features: { clinical: true } });
  closed = await createTenant(pool, 'Sets Closed', { features: { clinical: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Sets Admin', { withPassword: false });
  doctor = await createUser(pool, 'Sets Doctor', { withPassword: false });
  otherDoctor = await createUser(pool, 'Sets Other Doctor', { withPassword: false });
  nurse = await createUser(pool, 'Sets Nurse', { withPassword: false });
  receptionist = await createUser(pool, 'Sets Desk', { withPassword: false });
  custom = await createUser(pool, 'Sets Custom', { withPassword: false });
  for (const tenant of [hospital, clinic, closed])
    await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, otherDoctor, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await pool.query(
    "insert into roles (tenant_id, id, name) values ($1, 'set_keeper', 'Set keeper')",
    [hospital.id],
  );
  await pool.query(
    `insert into role_permissions (tenant_id, role_id, permission)
     values ($1, 'set_keeper', 'prescriptionSet:read'), ($1, 'set_keeper', 'prescriptionSet:manage')`,
    [hospital.id],
  );
  await addMembership(pool, custom, hospital, 'set_keeper');
  drugs.para = await drug(hospital, 'Setparacetamol');
  drugs.amox = await drug(hospital, 'Setamoxicillin');
  drugs.old = await drug(hospital, 'Setolddrug', true);
  clinicDrug = await drug(clinic, 'Setclinicdrug');
});

afterAll(async () => {
  try {
    await cleanUp();
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
    await deleteUsers(
      pool,
      [admin, doctor, otherDoctor, nurse, receptionist, custom].filter(Boolean),
    );
  } finally {
    await app.close();
  }
});

describe('own and shared sets', () => {
  it('adds a doctor’s own set with its lines named by the catalog, and audits it without the lines', async () => {
    const detail = await added({
      name: '  Fever  ',
      lines: [line(drugs.para!), line(drugs.amox!, { instructions: 'After food' })],
    });

    expect(detail.set).toMatchObject({
      tenantId: hospital.id,
      name: 'Fever',
      shared: false,
      lineCount: 2,
      version: 1,
    });
    expect(detail.lines.map((l) => l.drugName)).toEqual([
      'Setparacetamol 500 mg',
      'Setamoxicillin 500 mg',
    ]);
    const { rows } = await pool.query<{ action: string; detail: unknown }>(
      `select * from audit_log where tenant_id = $1 and entity = 'prescription_set' and entity_id = $2`,
      [hospital.id, detail.set.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('Setparacetamol');
  });

  it('keeps a doctor’s own set from every other doctor, and answers 404 as for a missing one', async () => {
    const own = await added({ name: 'Private set' });

    const seen = await call('GET', `/prescription-sets/${own.set.id}`, { user: otherDoctor });
    const missing = await call('GET', '/prescription-sets/00000000-0000-4000-8000-000000000000');
    expect(errorOf(seen)).toEqual([404, 'prescription_set_not_found']);
    expect(errorOf(missing)).toEqual([404, 'prescription_set_not_found']);
    const listed = (await call('GET', '/prescription-sets', { user: otherDoctor })).json<{
      items: { name: string }[];
    }>();
    expect(listed.items.map((item) => item.name)).not.toContain('Private set');
    const patch = await call(
      'PATCH',
      `/prescription-sets/${own.set.id}`,
      { user: otherDoctor },
      { version: 1, archived: true },
    );
    expect(patch.statusCode).toBe(404);
  });

  it('lets only whoever may share make a shared set, and every prescriber use it', async () => {
    const refused = await create({ name: 'Everyone', shared: true });
    expect(errorOf(refused)).toEqual([403, 'permission_denied']);

    const shared = await added({ name: 'Everyone', shared: true }, { user: admin });
    expect(shared.set.shared).toBe(true);

    const read = await call('GET', `/prescription-sets/${shared.set.id}`, { user: nurse });
    expect(read.statusCode).toBe(200);
    // A doctor can use it but not change or archive it.
    const change = await call(
      'PATCH',
      `/prescription-sets/${shared.set.id}`,
      {},
      { version: 1, name: 'Mine now' },
    );
    expect(errorOf(change)).toEqual([403, 'permission_denied']);
    const archived = await call(
      'PATCH',
      `/prescription-sets/${shared.set.id}`,
      { user: admin },
      { version: 1, archived: true },
    );
    expect(archived.json<Detail>().set).toMatchObject({ archived: true, version: 2 });
  });

  it('refuses a second set of the same name for one owner, but not for two', async () => {
    await added({ name: 'Same name' });
    expect(errorOf(await create({ name: 'SAME NAME' }))).toEqual([
      409,
      'prescription_set_name_taken',
    ]);
    expect((await create({ name: 'Same name' }, { user: otherDoctor })).statusCode).toBe(201);
  });

  it('holds 1 to 30 lines of medicines that may be prescribed', async () => {
    const thirty = Array.from({ length: 30 }, () => line(drugs.para!));
    expect((await create({ name: 'Thirty', lines: thirty })).statusCode).toBe(201);
    expect(
      (await create({ name: 'Thirty one', lines: [...thirty, line(drugs.para!)] })).statusCode,
    ).toBe(400);
    expect((await create({ name: 'None', lines: [] })).statusCode).toBe(400);
    expect(errorOf(await create({ name: 'Old', lines: [line(drugs.old!)] }))).toEqual([
      422,
      'unknown_drug',
    ]);
    expect(errorOf(await create({ name: 'Other', lines: [line(clinicDrug)] }))).toEqual([
      422,
      'unknown_drug',
    ]);
  });

  it('flags a medicine archived since, and does not drop it', async () => {
    const later = await drug(hospital, 'Setlater');
    const set = await added({ name: 'Later', lines: [line(later)] });
    await pool.query('update drugs set archived = true where id = $1', [later]);

    const read = (await call('GET', `/prescription-sets/${set.set.id}`)).json<Detail>();

    expect(read.lines[0]).toMatchObject({ drugId: later, drugArchived: true });
  });

  it('changes a set from the version it was read at, and replaces its lines', async () => {
    const set = await added({ name: 'Edit me' });
    const saved = await call(
      'PATCH',
      `/prescription-sets/${set.set.id}`,
      {},
      {
        version: 1,
        name: 'Edited',
        lines: [line(drugs.amox!), line(drugs.para!)],
      },
    );
    expect(saved.json<Detail>()).toMatchObject({
      set: { name: 'Edited', version: 2, lineCount: 2 },
    });
    const stale = await call(
      'PATCH',
      `/prescription-sets/${set.set.id}`,
      {},
      { version: 1, name: 'Again' },
    );
    expect(errorOf(stale)).toEqual([409, 'conflict']);
  });

  it('adds once for a repeated Idempotency-Key', async () => {
    const key = 'sets-key-0001';
    const first = await create({ name: 'Once' }, { key });
    const second = await create({ name: 'Once' }, { key });
    expect(second.statusCode).toBe(201);
    expect(second.json<Detail>().set.id).toBe(first.json<Detail>().set.id);
  });

  it('pages the list by name', async () => {
    const page = (await call('GET', '/prescription-sets?limit=2')).json<{
      items: unknown[];
      nextCursor: string | null;
      total: number;
    }>();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect((await call('GET', '/prescription-sets?cursor=junk')).statusCode).toBe(400);
  });
});

describe('permissions and the hospital boundary', () => {
  it('lets a nurse read and not write, and a receptionist do neither', async () => {
    expect((await call('GET', '/prescription-sets', { user: nurse })).statusCode).toBe(200);
    expect(errorOf(await create({ name: 'Nurse set' }, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await call('GET', '/prescription-sets', { user: receptionist }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('lets a custom role keep its own sets and share none', async () => {
    expect((await create({ name: 'Custom own' }, { user: custom })).statusCode).toBe(201);
    expect(
      errorOf(await create({ name: 'Custom shared', shared: true }, { user: custom })),
    ).toEqual([403, 'permission_denied']);
  });

  it('is off when the hospital’s clinical module is off', async () => {
    const response = await call('GET', '/prescription-sets', { tenant: closed, user: admin });
    expect(errorOf(response)).toEqual([403, 'feature_disabled']);
  });

  it('never shows one hospital’s sets or favourites to another, even for the same doctor', async () => {
    const set = await added({ name: 'Hospital only', shared: true }, { user: admin });
    const there = await call('GET', `/prescription-sets/${set.set.id}`, { tenant: clinic });
    expect(errorOf(there)).toEqual([404, 'prescription_set_not_found']);
    const listed = (await call('GET', '/prescription-sets', { tenant: clinic })).json<{
      items: unknown[];
    }>();
    expect(listed.items).toEqual([]);

    await call('PUT', '/me/favourite-drugs', {}, { drugIds: [drugs.para!] });
    const clinicFavourites = (await call('GET', '/me/favourite-drugs', { tenant: clinic })).json<{
      items: unknown[];
    }>();
    expect(clinicFavourites.items).toEqual([]);
    // A medicine of another hospital cannot be starred or put in a set.
    const starred = await call('PUT', '/me/favourite-drugs', {}, { drugIds: [clinicDrug] });
    expect(errorOf(starred)).toEqual([422, 'unknown_drug']);
    const rows = await pool.query('select 1 from prescription_sets where tenant_id = $1', [
      clinic.id,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('favourite medicines', () => {
  it('belong to the doctor, keep their order, and are replaced as a whole', async () => {
    const put = await call(
      'PUT',
      '/me/favourite-drugs',
      {},
      { drugIds: [drugs.amox!, drugs.para!] },
    );
    expect(put.json<{ items: { name: string }[] }>().items.map((i) => i.name)).toEqual([
      'Setamoxicillin 500 mg',
      'Setparacetamol 500 mg',
    ]);
    const mine = await call('GET', '/me/favourite-drugs');
    expect(mine.json<{ items: unknown[] }>().items).toHaveLength(2);
    const theirs = await call('GET', '/me/favourite-drugs', { user: otherDoctor });
    expect(theirs.json<{ items: unknown[] }>().items).toEqual([]);

    await call('PUT', '/me/favourite-drugs', {}, { drugIds: [drugs.para!] });
    expect(
      (await call('GET', '/me/favourite-drugs')).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
  });

  it('holds at most 20, each once, each a medicine that may be prescribed', async () => {
    expect(
      (await call('PUT', '/me/favourite-drugs', {}, { drugIds: Array(21).fill(drugs.para) }))
        .statusCode,
    ).toBe(400);
    expect(
      errorOf(
        await call('PUT', '/me/favourite-drugs', {}, { drugIds: [drugs.para!, drugs.para!] }),
      ),
    ).toEqual([422, 'unknown_drug']);
    expect(
      errorOf(await call('PUT', '/me/favourite-drugs', {}, { drugIds: [drugs.old!] })),
    ).toEqual([422, 'unknown_drug']);
  });

  it('flags a favourite archived since', async () => {
    const later = await drug(hospital, 'Setfavlater');
    await call('PUT', '/me/favourite-drugs', {}, { drugIds: [later] });
    await pool.query('update drugs set archived = true where id = $1', [later]);

    const mine = (await call('GET', '/me/favourite-drugs')).json<{
      items: { archived: boolean }[];
    }>();

    expect(mine.items[0]?.archived).toBe(true);
  });

  it('may be read by a nurse and kept by no one without the permission', async () => {
    expect((await call('GET', '/me/favourite-drugs', { user: nurse })).statusCode).toBe(200);
    expect(
      errorOf(await call('PUT', '/me/favourite-drugs', { user: nurse }, { drugIds: [] })),
    ).toEqual([403, 'permission_denied']);
  });
});
