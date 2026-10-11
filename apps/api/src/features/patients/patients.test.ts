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
 * The patients API through the real app and database: registration and MRNs, search, the
 * hospital boundary, permissions and field masking, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the patients module switched off. */
let closed: TestTenant;
/** A hospital with a large register, for search speed. */
let large: TestTenant;

/** A doctor at the hospital and at the clinic. */
let doctor: TestUser;
let receptionist: TestUser;
/** Views patients but not their contact details, and cannot register. */
let pharmacist: TestUser;
/** No patient permissions at all. */
let storeKeeper: TestUser;
/** In a custom role that sees only the patients it registered, without contact details. */
let clerk: TestUser;
/** In a custom role that may change patients but not read them. */
let updater: TestUser;
/** In a custom role whose patient permissions are scoped to a department. */
let wardStaff: TestUser;

const KEY = () => `key-${randomUUID()}`;

const asha = {
  firstName: 'Asha',
  lastName: 'Verma',
  dob: '1984-07-21',
  gender: 'female',
  phone: '+91 98000 12345',
  email: 'asha.verma@example.test',
  address: '12 Lake Road',
  contactConsent: { given: true },
} as const;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string | null;
}

const headers = ({ tenant = hospital, user = doctor }: Options = {}) => as(tenant.id, user.id);

const register = (body: object = asha, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url: '/patients',
    headers: {
      ...headers(options),
      ...(options.key === null ? {} : { 'idempotency-key': options.key ?? KEY() }),
    },
    payload: body,
  });

const search = (body: object = {}, options: Options = {}) =>
  app.inject({ method: 'POST', url: '/patients/search', headers: headers(options), payload: body });

const read = (id: string, options: Options = {}) =>
  app.inject({ method: 'GET', url: `/patients/${id}`, headers: headers(options) });

const change = (id: string, body: object, options: Options = {}) =>
  app.inject({ method: 'PATCH', url: `/patients/${id}`, headers: headers(options), payload: body });

const duplicates = (body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url: '/patients/duplicate-check',
    headers: headers(options),
    payload: body,
  });

interface Summary {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  phone: string;
  tenantId: string;
}
interface Page {
  items: Summary[];
  nextCursor: string | null;
  total?: number;
}

const audited = async (tenant: TestTenant, action: string, entityId?: string) => {
  const { rows } = await pool.query<{ actor_id: string; entity_id: string | null }>(
    `select actor_id, entity_id from audit_log
     where tenant_id = $1 and entity = 'patient' and action = $2
       and ($3::text is null or entity_id = $3)`,
    [tenant.id, action, entityId ?? null],
  );
  return rows;
};

const events = async (tenant: TestTenant, event: string, entityId: string) => {
  const { rows } = await pool.query<{ payload: Record<string, unknown>; actor_id: string }>(
    'select payload, actor_id from outbox where tenant_id = $1 and event = $2 and entity_id = $3',
    [tenant.id, event, entityId],
  );
  return rows;
};

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Patients Hospital', { features: { patients: true } });
  clinic = await createTenant(pool, 'Patients Clinic', { features: { patients: true } });
  closed = await createTenant(pool, 'Closed Hospital', { features: { patients: false } });
  large = await createTenant(pool, 'Large Hospital', { features: { patients: true } });
  for (const tenant of [hospital, clinic, closed, large]) await grantRoleDefaults(app, tenant);

  doctor = await createUser(pool, 'Patients Doctor', { withPassword: false });
  receptionist = await createUser(pool, 'Patients Receptionist', { withPassword: false });
  pharmacist = await createUser(pool, 'Patients Pharmacist', { withPassword: false });
  storeKeeper = await createUser(pool, 'Patients Storekeeper', { withPassword: false });
  clerk = await createUser(pool, 'Patients Clerk', { withPassword: false });
  for (const tenant of [hospital, clinic, closed, large]) await addMembership(pool, doctor, tenant);
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');

  // A role the hospital made for itself: its own patients only, and no contact details.
  await pool.query(
    "insert into roles (tenant_id, id, name) values ($1, 'ward_clerk', 'Ward clerk')",
    [hospital.id],
  );
  await pool.query(
    `insert into role_permissions (tenant_id, role_id, permission, scope) values
       ($1, 'ward_clerk', 'patient:read', 'own'),
       ($1, 'ward_clerk', 'patient:create', 'all'),
       ($1, 'ward_clerk', 'patient:update', 'own')`,
    [hospital.id],
  );
  await addMembership(pool, clerk, hospital, 'ward_clerk');

  updater = await createUser(pool, 'Patients Updater', { withPassword: false });
  wardStaff = await createUser(pool, 'Patients Ward Staff', { withPassword: false });
  await pool.query(
    "insert into roles (tenant_id, id, name) values ($1, 'updater', 'Updater'), ($1, 'ward_staff', 'Ward staff')",
    [hospital.id],
  );
  await pool.query(
    `insert into role_permissions (tenant_id, role_id, permission, scope) values
       ($1, 'updater', 'patient:update', 'all'),
       ($1, 'ward_staff', 'patient:read', 'department'),
       ($1, 'ward_staff', 'patient:update', 'department')`,
    [hospital.id],
  );
  await addMembership(pool, updater, hospital, 'updater');
  await addMembership(pool, wardStaff, hospital, 'ward_staff');
});

afterAll(async () => {
  // Patients have no ON DELETE CASCADE from tenants (a hospital with records is not deleted by
  // accident), so the test rows go first.
  const tenants = [hospital, clinic, closed, large].filter(Boolean);
  const users = [doctor, receptionist, pharmacist, storeKeeper, clerk, updater, wardStaff].filter(
    Boolean,
  );
  try {
    await pool.query('delete from patients where tenant_id = any($1::uuid[])', [
      tenants.map((tenant) => tenant.id),
    ]);
    await deleteTenants(pool, tenants);
    await deleteUsers(pool, users);
  } finally {
    await app.close();
  }
});

describe('registering a patient', () => {
  it('assigns the next MRN of the hospital and records who captured consent', async () => {
    const first = await register();
    const second = await register({ ...asha, firstName: 'Bina', phone: '98000 22222' });

    expect(first.statusCode).toBe(201);
    const body = first.json<
      Record<string, unknown> & { contactConsent: Record<string, unknown> }
    >();
    expect(body.mrn).toMatch(/^[A-Z0-9]{1,3}-0000001$/);
    expect(second.json<Summary>().mrn).toMatch(/-0000002$/);
    expect(body).toMatchObject({
      tenantId: hospital.id,
      firstName: 'Asha',
      lastName: 'Verma',
      dob: '1984-07-21',
      gender: 'female',
      phone: '+91 98000 12345',
      email: 'asha.verma@example.test',
      address: '12 Lake Road',
    });
    expect(body.contactConsent).toMatchObject({ given: true, recordedBy: doctor.id });
    expect(Date.parse(String(body.contactConsent.at))).toBeGreaterThan(Date.now() - 60_000);
  });

  it('numbers each hospital on its own', async () => {
    const response = await register(asha, { tenant: clinic });

    expect(response.statusCode).toBe(201);
    expect(response.json<Summary>().mrn).toMatch(/-0000001$/);
  });

  it('gives registrations made at the same moment different, consecutive MRNs', async () => {
    const before = await pool.query<{ last_value: string }>(
      'select last_value from patient_mrn_counters where tenant_id = $1',
      [clinic.id],
    );
    const start = Number(before.rows[0]?.last_value ?? 0);

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        register({ ...asha, firstName: `Twin${i}`, phone: `97000 0000${i}` }, { tenant: clinic }),
      ),
    );

    expect(responses.map((r) => r.statusCode)).toEqual(Array(8).fill(201));
    const numbers = responses
      .map((r) => Number(r.json<Summary>().mrn.split('-')[1]))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => start + 1 + i));
  });

  it('needs an Idempotency-Key, and a repeat returns the first patient’s id without a second row', async () => {
    const missing = await register(asha, { key: null });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_required');

    const key = KEY();
    const details = { ...asha, firstName: 'Once', phone: '96000 11111' };
    const first = await register(details, { key });
    const again = await register(details, { key });

    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    // No copy of the patient is kept for the replay: the id only.
    expect(again.json()).toEqual({ id: first.json<Summary>().id });
    const { rows } = await pool.query(
      "select 1 from patients where tenant_id = $1 and first_name = 'Once'",
      [hospital.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('leaves no gap in the numbering and no event when a registration is refused', async () => {
    const counter = () =>
      pool
        .query<{ last_value: string }>(
          'select last_value from patient_mrn_counters where tenant_id = $1',
          [hospital.id],
        )
        .then((result) => result.rows[0]?.last_value);
    const before = await counter();

    const refused = await Promise.all([
      register({ ...asha, dob: '2999-01-01' }),
      register({ ...asha, dob: '2023-02-30' }),
      register({ ...asha, firstName: '   ' }),
      register({ ...asha, email: 'not-an-address' }),
      register({ ...asha, phone: 'abc-def' }),
      register({ ...asha, gender: 'unknown' }),
    ]);

    expect(refused.map((r) => r.statusCode)).toEqual(Array(6).fill(400));
    expect(await counter()).toBe(before);
  });

  it('ignores an MRN, a hospital or an id sent by the client', async () => {
    const response = await register({
      ...asha,
      firstName: 'Forged',
      phone: '84000 50505',
      mrn: 'MINE-1',
      tenantId: clinic.id,
      id: randomUUID(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Summary>();
    expect(body.mrn).not.toBe('MINE-1');
    expect(body.tenantId).toBe(hospital.id);
    expect((await read(body.id, { tenant: clinic })).statusCode).toBe(404);
  });

  it('writes an audit entry and a patient.registered event that carry ids only', async () => {
    const created = (
      await register({ ...asha, firstName: 'Audited', phone: '95000 33333' })
    ).json<Summary>();

    expect(await audited(hospital, 'create', created.id)).toEqual([
      { actor_id: doctor.id, entity_id: created.id },
    ]);
    const [event] = await events(hospital, 'patient.registered', created.id);
    expect(event?.actor_id).toBe(doctor.id);
    expect(event?.payload).toEqual({ patientId: created.id });
    expect(JSON.stringify(event)).not.toContain('Audited');
  });
});

describe('searching', () => {
  it('finds by part of a name, by MRN and by the digits of a phone number', async () => {
    const created = (
      await register({
        ...asha,
        firstName: 'Zubeida',
        lastName: 'Qureshi',
        phone: '+91 94444 01234',
      })
    ).json<Summary>();

    const byName = (await search({ q: 'ubeid' })).json<Page>();
    const byMrn = (await search({ q: created.mrn.toLowerCase() })).json<Page>();
    const byPhone = (await search({ q: '94444-012' })).json<Page>();
    const none = (await search({ q: 'no-such-person-xyz' })).json<Page>();

    for (const page of [byName, byMrn, byPhone]) {
      expect(page.items.map((item) => item.id)).toContain(created.id);
    }
    expect(none).toMatchObject({ items: [], nextCursor: null, total: 0 });
  });

  it('treats what was typed as text, never as a pattern', async () => {
    const everything = (await search({ q: '%' })).json<Page>();
    const underscore = (await search({ q: '_' })).json<Page>();

    expect(everything.items).toEqual([]);
    expect(underscore.items).toEqual([]);
  });

  it('pages by cursor without repeating or skipping, and counts on the first page only', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let total: number | undefined;
    do {
      const page = (await search({ limit: 2, sort: 'name', cursor })).json<Page>();
      if (pages === 0) total = page.total;
      else expect(page.total).toBeUndefined();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 50);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(total ?? -1);
    expect(pages).toBeGreaterThan(1);
  });

  it('sorts by name and by MRN in both directions', async () => {
    const names = async (sort: string) =>
      (await search({ sort, limit: 100 }))
        .json<Page>()
        .items.map((item) => `${item.lastName} ${item.firstName}`.toLowerCase());
    const mrns = async (sort: string) =>
      (await search({ sort, limit: 100 })).json<Page>().items.map((item) => item.mrn);

    const ascending = await names('name');
    expect(ascending).toEqual([...ascending].sort());
    expect(await names('-name')).toEqual([...ascending].reverse());
    const byMrn = await mrns('mrn');
    expect(byMrn).toEqual([...byMrn].sort());
    expect(await mrns('-mrn')).toEqual([...byMrn].reverse());
  });

  it('refuses a cursor from another ordering and a page size over the limit', async () => {
    const page = (await search({ limit: 1, sort: 'name' })).json<Page>();

    const wrongSort = await search({ limit: 1, sort: 'mrn', cursor: page.nextCursor });
    const garbage = await search({ cursor: 'not-a-cursor' });
    const tooMany = await search({ limit: 101 });

    expect(wrongSort.statusCode).toBe(400);
    expect(wrongSort.json<{ error: { code: string } }>().error.code).toBe('invalid_cursor');
    expect(garbage.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(400);
  });

  it('audits the search as one entry', async () => {
    const before = (await audited(hospital, 'search')).length;
    await search({ q: 'verma' });
    expect((await audited(hospital, 'search')).length).toBe(before + 1);
  });
});

describe('the hospital boundary', () => {
  let patient: Summary;

  beforeAll(async () => {
    patient = (
      await register({ ...asha, firstName: 'Bounded', phone: '93000 44444' })
    ).json<Summary>();
  });

  it('keeps one hospital’s patients out of another’s search, record read and update', async () => {
    const fromClinic = { tenant: clinic };

    const found = (await search({ q: 'Bounded' }, fromClinic)).json<Page>();
    const opened = await read(patient.id, fromClinic);
    const changed = await change(patient.id, { firstName: 'Taken' }, fromClinic);

    expect(found.items).toEqual([]);
    expect(opened.statusCode).toBe(404);
    expect(changed.statusCode).toBe(404);
    expect((await read(patient.id)).json<Summary>().firstName).toBe('Bounded');
  });

  it('gives an empty page for a cursor that names another hospital’s patient', async () => {
    const page = (await search({ limit: 1, sort: 'name' })).json<Page>();

    const elsewhere = await search(
      { limit: 5, sort: 'name', cursor: page.nextCursor },
      { tenant: clinic },
    );

    expect(elsewhere.statusCode).toBe(200);
    expect(elsewhere.json<Page>().items).toEqual([]);
  });

  it('holds under the app role in SQL, for reads and for writes', async () => {
    const visible = await asTenantSql(pool, clinic.id, (client) =>
      client.query('select 1 from patients where tenant_id = $1', [hospital.id]),
    );
    const counter = await asTenantSql(pool, clinic.id, (client) =>
      client.query('select 1 from patient_mrn_counters where tenant_id = $1', [hospital.id]),
    );
    const moved = await asTenantSql(pool, clinic.id, (client) =>
      client.query("update patients set first_name = 'Taken' where id = $1", [patient.id]),
    );
    const noTenant = await asTenantSql(pool, null, (client) =>
      client.query('select 1 from patients'),
    );

    expect(visible.rowCount).toBe(0);
    expect(counter.rowCount).toBe(0);
    expect(moved.rowCount).toBe(0);
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
           values ($1, 'X-1', 'Planted', 'Row', '1990-01-01', 'other', '12345', 'someone')`,
          [hospital.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(noTenant.rowCount).toBe(0);
  });

  it('never lets a record change hospital or MRN, or be deleted', async () => {
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update patients set mrn = 'OTHER-1' where id = $1", [patient.id]),
      ),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('delete from patients where id = $1', [patient.id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('allows the same MRN in two hospitals but not twice in one', async () => {
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query(
          `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
           values ($1, $2, 'Second', 'Holder', '1990-01-01', 'other', '12345', 'someone')`,
          [hospital.id, patient.mrn],
        ),
      ),
    ).rejects.toThrow(/patients_mrn_per_tenant/);
  });
});

describe('permissions', () => {
  let patient: Summary;

  beforeAll(async () => {
    patient = (
      await register({ ...asha, firstName: 'Guarded', phone: '+91 92000 56789' })
    ).json<Summary>();
  });

  it('refuses every route to a role without the permission', async () => {
    const who = { user: storeKeeper };
    const responses = await Promise.all([
      search({}, who),
      read(patient.id, who),
      change(patient.id, { firstName: 'X' }, who),
      register(asha, who),
      duplicates({ firstName: 'A', lastName: 'B', dob: '1990-01-01', phone: '12345' }, who),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('permission_denied');
    }
  });

  it('refuses every route in a hospital with the module off', async () => {
    const where = { tenant: closed };
    const responses = await Promise.all([
      search({}, where),
      register(asha, where),
      read(patient.id, where),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('feature_disabled');
    }
  });

  it('lets a view-only role read, with the phone masked and no email or address', async () => {
    const who = { user: pharmacist };

    const listed = (await search({ q: 'Guarded' }, who)).json<Page>();
    const opened = (await read(patient.id, who)).json<Record<string, unknown>>();
    const refusedCreate = await register(asha, who);
    const refusedChange = await change(patient.id, { firstName: 'X' }, who);

    expect(listed.items[0]?.phone).toBe('•••••••••6789');
    expect(opened.phone).toBe('•••••••••6789');
    expect(opened).not.toHaveProperty('email');
    expect(opened).not.toHaveProperty('address');
    expect(JSON.stringify(opened)).not.toContain('92000');
    expect(refusedCreate.statusCode).toBe(403);
    expect(refusedChange.statusCode).toBe(403);
  });

  it('shows full contact details to a role that holds patient.contact:read', async () => {
    const opened = (await read(patient.id, { user: receptionist })).json<Record<string, unknown>>();

    expect(opened).toMatchObject({
      phone: '+91 92000 56789',
      email: asha.email,
      address: asha.address,
    });
  });

  it('narrows a role with the "own" scope to the patients it registered', async () => {
    const who = { user: clerk };
    const mine = (
      await register({ ...asha, firstName: 'Clerked', phone: '91000 77777' }, who)
    ).json<Summary>();

    const listed = (await search({ limit: 100 }, who)).json<Page>();
    const others = await read(patient.id, who);
    const changedOthers = await change(patient.id, { firstName: 'X' }, who);

    expect(listed.items.map((item) => item.id)).toEqual([mine.id]);
    expect(listed.total).toBe(1);
    expect(others.statusCode).toBe(404);
    expect(changedOthers.statusCode).toBe(404);
    expect((await read(mine.id, who)).statusCode).toBe(200);
  });

  it('does not let a role that cannot see contact details overwrite them', async () => {
    const who = { user: clerk };
    const mine = (
      await register({ ...asha, firstName: 'Kept', phone: '90000 88888' }, who)
    ).json<Summary>();

    const phone = await change(mine.id, { phone: '11111 11111' }, who);
    const name = await change(mine.id, { firstName: 'Renamed' }, who);

    expect(phone.statusCode).toBe(403);
    expect(name.statusCode).toBe(200);
    expect((await read(mine.id)).json<Summary>()).toMatchObject({
      firstName: 'Renamed',
      phone: '90000 88888',
    });
  });
});

describe('reading and changing a record', () => {
  it('audits each read of a record with its id', async () => {
    const patient = (
      await register({ ...asha, firstName: 'Opened', phone: '89000 10101' })
    ).json<Summary>();

    await read(patient.id);
    await read(patient.id, { user: receptionist });
    await read(randomUUID());

    const entries = await audited(hospital, 'read', patient.id);
    expect(entries.map((entry) => entry.actor_id).sort()).toEqual(
      [doctor.id, receptionist.id].sort(),
    );
  });

  it('answers 404 for an id that is not one, without asking the database to parse it', async () => {
    expect((await read('not-a-uuid')).statusCode).toBe(404);
    expect((await change('not-a-uuid', { firstName: 'X' })).statusCode).toBe(404);
  });

  it('changes only what was sent, clears with null, and emits patient.updated with field names', async () => {
    const patient = (
      await register({ ...asha, firstName: 'Before', phone: '88000 20202' })
    ).json<Summary>();

    const response = await change(patient.id, { firstName: ' After ', email: null });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      firstName: 'After',
      lastName: 'Verma',
      mrn: patient.mrn,
      address: asha.address,
    });
    expect(body).not.toHaveProperty('email');
    const [event] = await events(hospital, 'patient.updated', patient.id);
    expect(event?.payload).toEqual({ patientId: patient.id, fields: ['firstName', 'email'] });
    expect(JSON.stringify(event)).not.toContain('After');
    expect(await audited(hospital, 'update', patient.id)).toHaveLength(1);
  });

  it('records a new consent decision with the time and the person who changed it', async () => {
    const patient = (
      await register({ ...asha, firstName: 'Consent', phone: '87000 30303' })
    ).json<Summary>();

    const response = await change(
      patient.id,
      { contactConsent: { given: false } },
      { user: receptionist },
    );

    expect(response.json<{ contactConsent: unknown }>().contactConsent).toMatchObject({
      given: false,
      recordedBy: receptionist.id,
    });
  });

  it('refuses a change that is empty, invalid, or names a field that cannot change', async () => {
    const patient = (
      await register({ ...asha, firstName: 'Fixed', phone: '86000 40404' })
    ).json<Summary>();

    const responses = await Promise.all([
      change(patient.id, {}),
      change(patient.id, { dob: '2999-01-01' }),
      change(patient.id, { mrn: 'NEW-1' }),
      change(patient.id, { tenantId: clinic.id }),
      change(patient.id, { firstName: '  ' }),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual(Array(5).fill(400));
    expect((await read(patient.id)).json<Summary>()).toMatchObject({
      firstName: 'Fixed',
      mrn: patient.mrn,
    });
  });
});

describe('checking for duplicates', () => {
  it('returns masked matches without ids, for the same person by name and birth date or by phone', async () => {
    const existing = (
      await register({
        ...asha,
        firstName: 'Dupli',
        lastName: 'Cate',
        dob: '1970-05-05',
        phone: '+91 85000 54321',
      })
    ).json<Summary>();

    const byName = await duplicates({
      firstName: 'dupli',
      lastName: 'CATE',
      dob: '1970-05-05',
      phone: '00000 00000',
    });
    const byPhone = await duplicates({
      firstName: 'Other',
      lastName: 'Cate',
      dob: '1999-09-09',
      phone: '918500054321',
    });
    const nobody = await duplicates({
      firstName: 'Dupli',
      lastName: 'Cate',
      dob: '1971-05-05',
      phone: '00000 00000',
    });

    expect(byName.json()).toEqual({
      items: [
        {
          firstName: 'Dupli',
          lastName: 'Cate',
          dob: '1970-05-05',
          maskedMrn: `${'•'.repeat(existing.mrn.length - 3)}${existing.mrn.slice(-3)}`,
          maskedPhone: '•••••••••4321',
        },
      ],
    });
    expect(byPhone.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(nobody.json()).toEqual({ items: [] });
    expect(byName.body).not.toContain(existing.id);
    expect(byName.body).not.toContain('85000');
  });

  it('does not match a patient of another hospital', async () => {
    const response = await duplicates(
      { firstName: 'Dupli', lastName: 'Cate', dob: '1970-05-05', phone: '+91 85000 54321' },
      { tenant: clinic },
    );

    expect(response.json()).toEqual({ items: [] });
  });
});

describe('a large register', () => {
  const ROWS = 60_000;

  beforeAll(async () => {
    // Synthetic rows written straight in, as an import would: registering 60,000 through the API
    // would take minutes.
    await pool.query(
      `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
       select $1, 'LH-' || lpad(n::text, 6, '0'), 'First' || (n % 977), 'Last' || (n % 4999),
              date '1950-01-01' + (n % 20000), 'other', '9' || lpad(n::text, 9, '0'), 'seed'
       from generate_series(1, $2::int) as n`,
      [large.id, ROWS],
    );
    await pool.query('analyze patients');
  }, 120_000);

  it('answers a search and a deep page quickly', async () => {
    const started = performance.now();
    const found = await search({ q: 'last4321 first413', limit: 25 }, { tenant: large });
    const byPhone = await search({ q: '9000004321', limit: 25 }, { tenant: large });
    const elapsed = performance.now() - started;

    expect(found.statusCode).toBe(200);
    expect(found.json<Page>().items.map((item) => item.mrn)).toContain('LH-004321');
    expect(byPhone.json<Page>().items.map((item) => item.mrn)).toEqual(['LH-004321']);
    // Generous for a slow shared runner: a sequential scan of the table would still pass, so the
    // plan is asserted separately below.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('reads the first page and a deep page through the name index, without sorting or walking the register', async () => {
    const explain = async (sql: string, params: unknown[] = []) => {
      const result = await asTenantSql(pool, large.id, (client) =>
        client.query<{ 'QUERY PLAN': string }>(`explain ${sql}`, params),
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    };

    const first = await explain(
      'select id from patients order by last_name_lower, first_name_lower, id limit 26',
    );
    const deep = await explain(
      `select id from patients
       where (last_name_lower, first_name_lower, id) > ($1, $2, $3::uuid)
       order by last_name_lower, first_name_lower, id limit 26`,
      ['last4000', 'first500', '00000000-0000-4000-8000-000000000000'],
    );

    for (const plan of [first, deep]) {
      expect(plan).toMatch(/Index (Only )?Scan using patients_tenant_name/);
      expect(plan).not.toMatch(/Sort/);
    }
    // The cursor is where the index scan starts, not a filter applied to every row before it.
    expect(deep).toMatch(/Index Cond:.*ROW\(last_name_lower, first_name_lower, id\) >/);
  });

  it('pages to the end of a filtered list in a few requests', async () => {
    let cursor: string | undefined;
    let seen = 0;
    let pages = 0;
    do {
      const page = (
        await search({ q: 'last42', limit: 100, sort: '-name', cursor }, { tenant: large })
      ).json<Page>();
      seen += page.items.length;
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);

    // last42, last420 to last429 and last4200 to last4299: 111 surnames, 12 or 13 people each.
    expect(seen).toBeGreaterThan(1_000);
    expect(pages).toBeLessThan(20);
  });

  it('has no trigram index on patients, since row-level security keeps one from being used', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'patients' and indexdef ilike '%trgm%'",
    );

    expect(rows).toEqual([]);
  });
});

describe('what the reviews asked for', () => {
  let alpha: Summary;

  beforeAll(async () => {
    alpha = (
      await register({
        ...asha,
        firstName: 'Ishaan',
        lastName: 'Rathore',
        phone: '+91 83111 22233',
      })
    ).json<Summary>();
  });

  it('finds words in any order, and needs every word', async () => {
    const reversed = (await search({ q: 'rathore ishaan' })).json<Page>();
    const partial = (await search({ q: 'ish rath' })).json<Page>();
    const oneWrong = (await search({ q: 'ishaan nobody' })).json<Page>();

    expect(reversed.items.map((item) => item.id)).toEqual([alpha.id]);
    expect(partial.items.map((item) => item.id)).toEqual([alpha.id]);
    expect(oneWrong.items).toEqual([]);
  });

  it('counts the matches of a search on its first page', async () => {
    const page = (await search({ q: 'rathore', limit: 1 })).json<Page>();

    expect(page.total).toBe(1);
  });

  it('does not treat the digits of an MRN as a phone number', async () => {
    // A patient whose phone contains the digits of another patient's MRN.
    const digits = alpha.mrn.replace(/\D/g, '');
    const decoy = (
      await register({ ...asha, firstName: 'Decoy', lastName: 'Phone', phone: `9${digits}99` })
    ).json<Summary>();

    const byMrn = (await search({ q: alpha.mrn })).json<Page>();

    expect(byMrn.items.map((item) => item.id)).toEqual([alpha.id]);
    expect(byMrn.items.map((item) => item.id)).not.toContain(decoy.id);
  });

  it('searches phone numbers only for someone who may see them', async () => {
    const full = (await search({ q: '83111 22233' }, { user: receptionist })).json<Page>();
    const masked = (await search({ q: '83111 22233' }, { user: pharmacist })).json<Page>();
    const guessing = (await search({ q: '8311122' }, { user: pharmacist })).json<Page>();

    expect(full.items.map((item) => item.id)).toEqual([alpha.id]);
    // Otherwise the masked number could be recovered digit by digit from what matches.
    expect(masked).toMatchObject({ items: [], total: 0 });
    expect(guessing).toMatchObject({ items: [], total: 0 });
  });

  it('gives an empty page for a cursor that names a colleague’s patient under the "own" scope', async () => {
    const who = { user: clerk };
    await register({ ...asha, firstName: 'Aaa', lastName: 'Aaa', phone: '82000 00001' }, who);
    await register({ ...asha, firstName: 'Zzz', lastName: 'Zzz', phone: '82000 00002' }, who);
    // A cursor a doctor was given, naming a patient the clerk did not register.
    const doctorsPage = (await search({ q: 'rathore', limit: 1, sort: 'name' })).json<Page>();
    const forged = Buffer.from(`name:${alpha.id}`).toString('base64url');
    expect(doctorsPage.items[0]?.id).toBe(alpha.id);

    const page = await search({ sort: 'name', cursor: forged }, who);

    expect(page.statusCode).toBe(200);
    expect(page.json<Page>().items).toEqual([]);
  });

  it('needs patient:read as well as patient:update to change a record', async () => {
    const response = await change(alpha.id, { firstName: 'Peeked' }, { user: updater });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('Rathore');
    expect((await read(alpha.id)).json<Summary>().firstName).toBe('Ishaan');
  });

  it('shows nothing to a role scoped to a department, until departments exist', async () => {
    const who = { user: wardStaff };

    expect((await search({ limit: 100 }, who)).json<Page>()).toMatchObject({ items: [], total: 0 });
    expect((await read(alpha.id, who)).statusCode).toBe(404);
    expect((await change(alpha.id, { firstName: 'X' }, who)).statusCode).toBe(404);
  });

  it('writes and announces nothing when a change sends what is already there', async () => {
    const patient = (
      await register({ ...asha, firstName: 'Same', phone: '81000 60606' })
    ).json<Summary>();

    const response = await change(patient.id, {
      firstName: 'Same',
      dob: asha.dob,
      contactConsent: { given: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Summary>().firstName).toBe('Same');
    expect(await events(hospital, 'patient.updated', patient.id)).toEqual([]);
  });

  it('matches a duplicate by phone whether or not the country code was typed', async () => {
    await register({
      ...asha,
      firstName: 'Coded',
      lastName: 'Number',
      dob: '1961-01-01',
      phone: '+91 80111 33355',
    });
    const query = { firstName: 'Someone', lastName: 'Number', dob: '2001-01-01' };

    const without = await duplicates({ ...query, phone: '80111 33355' });
    const withCode = await duplicates({ ...query, phone: '0091-80111-33355' });
    const tooShort = await duplicates({ ...query, lastName: 'Else', phone: '33355' });

    expect(without.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(withCode.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(tooShort.json()).toEqual({ items: [] });
  });

  it.each(['name', '-name', 'mrn', '-mrn'])(
    'pages through the whole list sorted by %s, including people with the same name',
    async (sort) => {
      // Three people with one name, so a page boundary falls among equals.
      for (const phone of ['79000 00001', '79000 00002', '79000 00003']) {
        await register({ ...asha, firstName: 'Twin', lastName: 'Same', phone });
      }
      const all = (await search({ sort, limit: 100 })).json<Page>().items.map((item) => item.id);

      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = (await search({ sort, limit: 2, cursor })).json<Page>();
        paged.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor && paged.length < 500);

      expect(all.length).toBeLessThan(100);
      expect(paged).toEqual(all);
    },
  );

  it('refuses a birth date after today at the hospital', async () => {
    const { rows } = await pool.query<{ today: string; tomorrow: string }>(
      `select (now() at time zone timezone)::date::text as today,
              ((now() at time zone timezone)::date + 1)::text as tomorrow
       from tenants where id = $1`,
      [hospital.id],
    );

    const today = await register({
      ...asha,
      firstName: 'Newborn',
      phone: '78000 00001',
      dob: rows[0]?.today,
    });
    const tomorrow = await register({
      ...asha,
      firstName: 'Unborn',
      phone: '78000 00002',
      dob: rows[0]?.tomorrow,
    });

    expect(today.statusCode).toBe(201);
    expect(tomorrow.statusCode).toBe(400);
  });
});
