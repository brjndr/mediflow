import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
 * The queue API through the real app and database: numbering under concurrent desks, call order,
 * call-next for two doctors at once, the changes of status, the hospital boundary, scope,
 * permissions, audit, events and the live stream.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** The queue module switched off. */
let closed: TestTenant;
let admin: TestUser;
let desk: TestUser;
let docA: TestUser;
let docB: TestUser;
let docC: TestUser;
let nurse: TestUser;
let storeKeeper: TestUser;
let clinicDesk: TestUser;
/** Department ids: General (doctors A and B) and Surgery (doctor C) at the hospital. */
const departments = { general: '', surgery: '', archived: '', clinic: '' };
const doctors = { a: '', b: '', c: '', clinic: '' };
const patients = { one: '', two: '', three: '', four: '', clinic: '' };
/** More of the hospital's, one per request of the concurrency tests. */
const crowd: string[] = [];

interface Token {
  id: string;
  tenantId: string;
  number: number;
  day: string;
  departmentId: string;
  departmentName: string;
  doctorId?: string;
  doctorName?: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  status: string;
  priority?: string;
  issuedAt: string;
  calledAt?: string;
  callCount: number;
  version: number;
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string | null;
}
type Reply = { statusCode: number; json: <T = { error: { code: string } }>() => T };

const headers = ({ tenant = hospital, user = desk, key = randomUUID() }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key === null ? {} : { 'idempotency-key': key }),
});
const get = (url: string, options: Options = {}) =>
  app.inject({ url, headers: as((options.tenant ?? hospital).id, (options.user ?? desk).id) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({ method: 'POST', url, headers: headers(options), payload: body });
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

async function issued(body: object, options: Options = {}): Promise<Token> {
  const response = await post('/queue/tokens', body, options);
  if (response.statusCode !== 201) {
    throw new Error(`issuing failed in test setup: ${response.statusCode} ${response.body}`);
  }
  return response.json<Token>();
}
const list = async (query: string, options: Options = {}) =>
  (await get(`/queue/tokens?${query}`, options)).json<Page<Token>>();
const callNext = (doctorId: string, options: Options = {}) =>
  post('/queue/call-next', { doctorId }, { user: docA, ...options });

const clearQueue = async () => {
  const tenants = [hospital.id, clinic.id, closed.id];
  await pool.query('delete from vitals where tenant_id = any($1)', [tenants]);
  await pool.query('delete from queue_tokens where tenant_id = any($1)', [tenants]);
  await pool.query('delete from queue_counters where tenant_id = any($1)', [tenants]);
};

async function addDepartment(tenant: TestTenant, name: string, archived = false) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name, archived) values ($1, $2, $3) returning id',
    [tenant.id, name, archived],
  );
  return rows[0]?.id ?? '';
}

async function addDoctor(tenant: TestTenant, user: TestUser, departmentId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General practice', 15) returning id`,
    [tenant.id, user.id, departmentId],
  );
  return rows[0]?.id ?? '';
}

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string, last: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, $4, '1980-01-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `QU-${String(mrn).padStart(7, '0')}`, first, last],
  );
  return rows[0]?.id ?? '';
}

const audited = async (entityId: string) =>
  (
    await pool.query<{ action: string }>(
      `select action from audit_log
       where tenant_id = $1 and entity = 'queue_token' and entity_id = $2 order by at`,
      [hospital.id, entityId],
    )
  ).rows.map((row) => row.action);

const events = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at',
      [hospital.id, entityId],
    )
  ).rows;

/** Takes a permission away from a built-in role at a hospital, for the length of `run`. */
async function without<T>(
  tenant: TestTenant,
  role: string,
  permission: string,
  run: () => Promise<T>,
) {
  await pool.query(
    'delete from role_permissions where tenant_id = $1 and role_id = $2 and permission = $3',
    [tenant.id, role, permission],
  );
  try {
    return await run();
  } finally {
    await pool.query(
      `insert into role_permissions (tenant_id, role_id, permission, scope)
       values ($1, $2, $3, 'all') on conflict do nothing`,
      [tenant.id, role, permission],
    );
  }
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { queue: true, patients: true, doctors: true, departments: true };
  hospital = await createTenant(pool, 'Queue Hospital', { features });
  clinic = await createTenant(pool, 'Queue Clinic', { features, timezone: 'Asia/Dubai' });
  closed = await createTenant(pool, 'Queue Closed', { features: { ...features, queue: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Queue Admin');
  desk = await user('Queue Desk');
  docA = await user('Queue Doctor A');
  docB = await user('Queue Doctor B');
  docC = await user('Queue Doctor C');
  nurse = await user('Queue Nurse');
  storeKeeper = await user('Queue Store');
  clinicDesk = await user('Queue Clinic Desk');
  for (const tenant of [hospital, closed]) {
    await addMembership(pool, admin, tenant, 'admin');
    await addMembership(pool, desk, tenant, 'receptionist');
  }
  await addMembership(pool, docA, hospital, 'doctor');
  await addMembership(pool, docB, hospital, 'doctor');
  await addMembership(pool, docC, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');
  await addMembership(pool, clinicDesk, clinic, 'receptionist');
  await addMembership(pool, docA, clinic, 'doctor');
  departments.general = await addDepartment(hospital, 'General Medicine');
  departments.surgery = await addDepartment(hospital, 'Surgery');
  departments.archived = await addDepartment(hospital, 'Closed Ward', true);
  departments.clinic = await addDepartment(clinic, 'Family Medicine');
  doctors.a = await addDoctor(hospital, docA, departments.general);
  doctors.b = await addDoctor(hospital, docB, departments.general);
  doctors.c = await addDoctor(hospital, docC, departments.surgery);
  doctors.clinic = await addDoctor(clinic, docA, departments.clinic);
  patients.one = await addPatient(hospital, 'Priya', 'Sharma');
  patients.two = await addPatient(hospital, 'Ravi', 'Kumar');
  patients.three = await addPatient(hospital, 'Meena', 'Das');
  patients.four = await addPatient(hospital, 'Arjun', 'Rao');
  for (let n = 1; n <= 8; n++) crowd.push(await addPatient(hospital, 'Crowd', `Member ${n}`));
  patients.clinic = await addPatient(clinic, 'Omar', 'Ali');
});

afterEach(clearQueue);

afterAll(async () => {
  await clearQueue();
  const tenants = [hospital.id, clinic.id, closed.id];
  await pool.query('delete from outbox where tenant_id = any($1)', [tenants]);
  await pool.query('delete from patients where tenant_id = any($1)', [tenants]);
  await pool.query('delete from doctors where tenant_id = any($1)', [tenants]);
  await pool.query('delete from departments where tenant_id = any($1)', [tenants]);
  await deleteUsers(pool, [admin, desk, docA, docB, docC, nurse, storeKeeper, clinicDesk]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('issuing a token', () => {
  it('numbers each department’s tokens from 1, today at the hospital, and names the patient', async () => {
    const first = await issued({ patientId: patients.one, departmentId: departments.general });
    const second = await issued({
      patientId: patients.two,
      departmentId: departments.general,
      doctorId: doctors.a,
      priority: 'senior_citizen',
    });
    const surgery = await issued({ patientId: patients.one, departmentId: departments.surgery });
    expect([first.number, second.number, surgery.number]).toEqual([1, 2, 1]);
    const { rows } = await pool.query<{ today: string }>(
      "select (now() at time zone 'Asia/Kolkata')::date::text as today",
    );
    expect(first).toMatchObject({
      tenantId: hospital.id,
      day: rows[0]?.today,
      departmentName: 'General Medicine',
      patientName: 'Priya Sharma',
      status: 'waiting',
      callCount: 0,
      version: 1,
    });
    expect(first.doctorId).toBeUndefined();
    expect(second).toMatchObject({
      doctorId: doctors.a,
      doctorName: 'Queue Doctor A',
      priority: 'senior_citizen',
    });
    expect(await audited(first.id)).toEqual(['create']);
    expect(await events(first.id)).toEqual([
      {
        event: 'queue.token_issued',
        payload: {
          tokenId: first.id,
          patientId: patients.one,
          departmentId: departments.general,
          doctorId: null,
          number: 1,
          day: first.day,
        },
      },
    ]);
  });

  it('gives desks issuing at the same moment consecutive numbers, never the same one', async () => {
    const responses = await Promise.all(
      crowd.map((patientId) =>
        post('/queue/tokens', { patientId, departmentId: departments.general }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(crowd.map(() => 201));
    const numbers = responses
      .map((response) => response.json<Token>().number)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('refuses a second open token for the patient in that department, even at the same moment', async () => {
    const twice = await Promise.all([
      post('/queue/tokens', { patientId: patients.one, departmentId: departments.general }),
      post('/queue/tokens', { patientId: patients.one, departmentId: departments.general }),
    ]);
    expect(twice.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const refused = twice.find((response) => response.statusCode === 409);
    expect(refused && errorOf(refused)).toEqual([409, 'already_queued']);
    // The refused token gave its number back.
    const next = await issued({ patientId: patients.two, departmentId: departments.general });
    expect(next.number).toBe(2);
  });

  it('refuses a doctor of another department, an unknown department and an archived one', async () => {
    const body = { patientId: patients.one, departmentId: departments.general };
    expect(errorOf(await post('/queue/tokens', { ...body, doctorId: doctors.c }))).toEqual([
      422,
      'doctor_not_in_department',
    ]);
    expect(errorOf(await post('/queue/tokens', { ...body, doctorId: doctors.clinic }))).toEqual([
      422,
      'doctor_not_in_department',
    ]);
    for (const departmentId of [departments.archived, departments.clinic, randomUUID(), 'x']) {
      expect(errorOf(await post('/queue/tokens', { ...body, departmentId }))).toEqual([
        422,
        'unknown_department',
      ]);
    }
  });

  it('gives the same answer for another hospital’s patient and for a role that may not read patients', async () => {
    const body = { departmentId: departments.general };
    expect(errorOf(await post('/queue/tokens', { ...body, patientId: patients.clinic }))).toEqual([
      422,
      'unknown_patient',
    ]);
    await without(hospital, 'receptionist', 'patient:read', async () => {
      expect(errorOf(await post('/queue/tokens', { ...body, patientId: patients.one }))).toEqual([
        422,
        'unknown_patient',
      ]);
    });
  });

  it('needs an idempotency key, and answers a repeat with the same token', async () => {
    const body = { patientId: patients.one, departmentId: departments.general };
    const missing = await post('/queue/tokens', body, { key: null });
    expect(missing.statusCode).toBe(400);
    const key = randomUUID();
    const first = await post('/queue/tokens', body, { key });
    const again = await post('/queue/tokens', body, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Token>().id).toBe(first.json<Token>().id);
    expect(await audited(first.json<Token>().id)).toEqual(['create', 'read']);
  });
});

describe('the board', () => {
  it('lists a status in call order: a priority first, then the time issued', async () => {
    const one = await issued({ patientId: patients.one, departmentId: departments.general });
    const two = await issued({ patientId: patients.two, departmentId: departments.general });
    const three = await issued({
      patientId: patients.three,
      departmentId: departments.general,
      priority: 'pregnancy',
    });
    const page = await list('status=waiting');
    expect(page.items.map((token) => token.id)).toEqual([three.id, one.id, two.id]);
    expect(page.total).toBe(3);
    for (const token of [one, two, three])
      expect(await audited(token.id)).toEqual(['create', 'read']);
  });

  it('pages with a cursor, and refuses one it did not make', async () => {
    for (const patientId of crowd.slice(0, 5)) {
      await issued({ patientId, departmentId: departments.general });
    }
    const first = await list('status=waiting&limit=2');
    expect(first.items.map((token) => token.number)).toEqual([1, 2]);
    const second = await list(`status=waiting&limit=2&cursor=${first.nextCursor ?? ''}`);
    expect(second.items.map((token) => token.number)).toEqual([3, 4]);
    expect(second.total).toBeUndefined();
    const third = await list(`status=waiting&limit=2&cursor=${second.nextCursor ?? ''}`);
    expect(third.items.map((token) => token.number)).toEqual([5]);
    expect(third.nextCursor).toBeNull();
    expect(errorOf(await get('/queue/tokens?status=waiting&cursor=bad'))).toEqual([
      400,
      'invalid_cursor',
    ]);
  });

  it('gives a doctor’s queue: their tokens and their department’s given to nobody', async () => {
    const forA = await issued({
      patientId: patients.one,
      departmentId: departments.general,
      doctorId: doctors.a,
    });
    const forB = await issued({
      patientId: patients.two,
      departmentId: departments.general,
      doctorId: doctors.b,
    });
    const anyone = await issued({ patientId: patients.three, departmentId: departments.general });
    await issued({ patientId: patients.four, departmentId: departments.surgery });
    const page = await list(`status=waiting&doctorId=${doctors.a}`);
    expect(page.items.map((token) => token.id)).toEqual([forA.id, anyone.id]);
    expect(page.items.map((token) => token.id)).not.toContain(forB.id);
    const surgery = await list(`status=waiting&departmentId=${departments.surgery}`);
    expect(surgery.items).toHaveLength(1);
  });

  it('applies the scope of queue:read, whatever the filters say', async () => {
    await issued({ patientId: patients.one, departmentId: departments.general });
    const surgery = await issued({ patientId: patients.two, departmentId: departments.surgery });
    await pool.query(
      "update role_permissions set scope = 'department' where tenant_id = $1 and role_id = 'doctor' and permission = 'queue:read'",
      [hospital.id],
    );
    try {
      const page = await list('status=waiting', { user: docC });
      expect(page.items.map((token) => token.id)).toEqual([surgery.id]);
      const asked = await list(`status=waiting&departmentId=${departments.general}`, {
        user: docC,
      });
      expect(asked.items).toEqual([]);
    } finally {
      await pool.query(
        "update role_permissions set scope = 'all' where tenant_id = $1 and role_id = 'doctor' and permission = 'queue:read'",
        [hospital.id],
      );
    }
  });
});

describe('calling', () => {
  it('calls the first in call order, gives it to the doctor and serves the one before', async () => {
    const one = await issued({ patientId: patients.one, departmentId: departments.general });
    const urgent = await issued({
      patientId: patients.two,
      departmentId: departments.general,
      priority: 'clinical_urgency',
    });
    const called = await callNext(doctors.a);
    expect(called.statusCode).toBe(200);
    expect(called.json<Token>()).toMatchObject({
      id: urgent.id,
      status: 'called',
      doctorId: doctors.a,
      callCount: 1,
      version: 2,
    });
    const next = await callNext(doctors.a);
    expect(next.json<Token>().id).toBe(one.id);
    const served = await list('status=served');
    expect(served.items.map((token) => token.id)).toEqual([urgent.id]);
    expect(await audited(urgent.id)).toEqual(['create', 'update', 'update', 'read']);
    expect((await events(urgent.id)).map((event) => event.event)).toEqual([
      'queue.token_issued',
      'queue.called',
    ]);
    expect((await events(one.id))[1]?.payload).toMatchObject({
      tokenId: one.id,
      doctorId: doctors.a,
      callCount: 1,
      servedTokenId: urgent.id,
    });
  });

  it('says the queue is empty and leaves the doctor serving the same patient', async () => {
    await issued({ patientId: patients.one, departmentId: departments.general });
    const called = (await callNext(doctors.a)).json<Token>();
    expect(errorOf(await callNext(doctors.a))).toEqual([409, 'queue_empty']);
    expect((await list('status=called')).items.map((token) => token.id)).toEqual([called.id]);
  });

  it('never gives two doctors calling at the same moment the same patient', async () => {
    for (const patientId of crowd.slice(0, 2)) {
      await issued({ patientId, departmentId: departments.general });
    }
    const [a, b] = await Promise.all([callNext(doctors.a), callNext(doctors.b, { user: docB })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json<Token>().id).not.toBe(b.json<Token>().id);
  });

  it('calls one doctor’s queue once when the same doctor calls twice at once', async () => {
    for (const patientId of crowd.slice(0, 3)) {
      await issued({ patientId, departmentId: departments.general });
    }
    const both = await Promise.all([callNext(doctors.a), callNext(doctors.a)]);
    expect(both.map((response) => response.statusCode)).toEqual([200, 200]);
    // The second waited for the first, so it served the first's patient and called the next.
    expect((await list('status=called')).items).toHaveLength(1);
    expect((await list('status=served')).items).toHaveLength(1);
  });

  it('refuses a doctor who does not practise here, or outside the scope of queue:call', async () => {
    expect(errorOf(await callNext(doctors.clinic))).toEqual([422, 'unknown_doctor']);
    await pool.query(
      "update role_permissions set scope = 'own' where tenant_id = $1 and role_id = 'doctor' and permission = 'queue:call'",
      [hospital.id],
    );
    try {
      await issued({ patientId: patients.one, departmentId: departments.general });
      expect(errorOf(await callNext(doctors.b))).toEqual([422, 'unknown_doctor']);
      expect((await callNext(doctors.a)).statusCode).toBe(200);
    } finally {
      await pool.query(
        "update role_permissions set scope = 'all' where tenant_id = $1 and role_id = 'doctor' and permission = 'queue:call'",
        [hospital.id],
      );
    }
  });

  it('answers a repeated call-next with the token it called, calling nobody else', async () => {
    for (const patientId of crowd.slice(0, 2)) {
      await issued({ patientId, departmentId: departments.general });
    }
    const key = randomUUID();
    const first = await callNext(doctors.a, { key });
    const again = await callNext(doctors.a, { key });
    expect(again.json<Token>().id).toBe(first.json<Token>().id);
    expect((await list('status=waiting')).items).toHaveLength(1);
  });
});

describe('changing a token', () => {
  async function calledToken() {
    await issued({ patientId: patients.one, departmentId: departments.general });
    return (await callNext(doctors.a)).json<Token>();
  }
  const change = (token: Token, path: string, body: object = {}, options: Options = {}) =>
    post(
      `/queue/tokens/${token.id}/${path}`,
      { version: token.version, ...body },
      { user: nurse, ...options },
    );

  it('calls again, skips, puts back and sets a priority, each from the version it read', async () => {
    const token = await calledToken();
    const again = await change(token, 'call-again');
    expect(again.json<Token>()).toMatchObject({ status: 'called', callCount: 2, version: 3 });
    const skipped = await change(again.json<Token>(), 'skip');
    expect(skipped.json<Token>()).toMatchObject({ status: 'skipped', doctorId: doctors.a });
    const urgent = await change(skipped.json<Token>(), 'priority', {
      priority: 'clinical_urgency',
    });
    expect(urgent.json<Token>().priority).toBe('clinical_urgency');
    const back = await change(urgent.json<Token>(), 'recall');
    expect(back.json<Token>()).toMatchObject({ status: 'waiting', version: 6 });
    const cleared = await change(back.json<Token>(), 'priority', { priority: null });
    expect(cleared.json<Token>().priority).toBeUndefined();
    expect(await audited(token.id)).toEqual([
      'create',
      'update',
      'update',
      'update',
      'update',
      'update',
      'update',
    ]);
  });

  it('refuses a change the status does not allow and one from an old version', async () => {
    const token = await calledToken();
    expect(errorOf(await change(token, 'recall'))).toEqual([409, 'invalid_transition']);
    expect(errorOf(await change(token, 'priority', { priority: 'child' }))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect(errorOf(await change({ ...token, version: 1 }, 'skip'))).toEqual([409, 'conflict']);
  });

  it('answers 404 for another hospital’s token and for one that does not exist', async () => {
    const theirs = await issued(
      { patientId: patients.clinic, departmentId: departments.clinic },
      { tenant: clinic, user: clinicDesk },
    );
    expect(errorOf(await change(theirs, 'priority', { priority: 'child' }))).toEqual([
      404,
      'token_not_found',
    ]);
    expect(errorOf(await change({ ...theirs, id: randomUUID() }, 'skip'))).toEqual([
      404,
      'token_not_found',
    ]);
  });
});

describe('access', () => {
  it('lets the desk issue but not call, and the nurse call but not issue', async () => {
    await issued({ patientId: patients.one, departmentId: departments.general });
    expect(errorOf(await callNext(doctors.a, { user: desk }))).toEqual([403, 'permission_denied']);
    expect(
      errorOf(
        await post(
          '/queue/tokens',
          { patientId: patients.two, departmentId: departments.general },
          { user: nurse },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
    expect((await callNext(doctors.a, { user: nurse })).statusCode).toBe(200);
  });

  it('refuses a role without the queue, and a hospital with the module off', async () => {
    expect(errorOf(await get('/queue/tokens?status=waiting', { user: storeKeeper }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await get('/queue/tokens?status=waiting', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(errorOf(await get('/queue/events', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('the hospital boundary', () => {
  it('shows no hospital another’s tokens and lets none write one', async () => {
    const ours = await issued({ patientId: patients.one, departmentId: departments.general });
    const atClinic = await list('status=waiting', { tenant: clinic, user: clinicDesk });
    expect(atClinic.items).toEqual([]);
    await asTenantSql(pool, clinic.id, async (client) => {
      expect((await client.query('select id from queue_tokens')).rows).toEqual([]);
      expect((await client.query('select 1 from queue_counters')).rows).toEqual([]);
      const updated = await client.query(
        "update queue_tokens set priority = 'child' where id = $1",
        [ours.id],
      );
      expect(updated.rowCount).toBe(0);
    });
    // A row for another hospital, or one pointing at another hospital's patient or department.
    for (const [tenantId, patientId, departmentId] of [
      [hospital.id, patients.one, departments.general],
      [clinic.id, patients.one, departments.clinic],
      [clinic.id, patients.clinic, departments.general],
    ]) {
      await expect(
        asTenantSql(pool, clinic.id, (client) =>
          client.query(
            `insert into queue_tokens (tenant_id, day, department_id, number, patient_id, issued_by)
             values ($1, current_date, $3, 99, $2, $4)`,
            [tenantId, patientId, departmentId, clinicDesk.id],
          ),
        ),
      ).rejects.toThrow();
    }
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query('delete from queue_tokens')).rejects.toThrow();
    });
  });

  it('refuses a move the queue does not allow, and any change of a served token, in the database', async () => {
    const token = await issued({ patientId: patients.one, departmentId: departments.general });
    await expect(
      pool.query("update queue_tokens set status = 'served' where id = $1", [token.id]),
    ).rejects.toThrow(/does not move/);
    await pool.query(
      "update queue_tokens set status = 'called', doctor_id = $2, called_at = now() where id = $1",
      [token.id, doctors.a],
    );
    await expect(
      pool.query('update queue_tokens set doctor_id = $2 where id = $1', [token.id, doctors.b]),
    ).rejects.toThrow(/given once/);
    await pool.query("update queue_tokens set status = 'served' where id = $1", [token.id]);
    await expect(
      pool.query("update queue_tokens set priority = 'child' where id = $1", [token.id]),
    ).rejects.toThrow(/final/);
  });
});

describe('the live stream', () => {
  let base = '';

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  interface Stream {
    status: number;
    contentType: string | null;
    /** Each event block received, without its blank line. */
    blocks: string[];
    ended(): boolean;
    close(): void;
  }

  async function open(options: Options = {}): Promise<Stream> {
    const controller = new AbortController();
    const response = await fetch(`${base}/queue/events`, {
      headers: as((options.tenant ?? hospital).id, (options.user ?? desk).id),
      signal: controller.signal,
    });
    const blocks: string[] = [];
    let ended = false;
    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
              blocks.push(buffer.slice(0, end));
              buffer = buffer.slice(end + 2);
            }
          }
        } catch {
          // Aborted by the test.
        }
        ended = true;
      })();
    } else {
      ended = true;
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      blocks,
      ended: () => ended,
      close: () => controller.abort(),
    };
  }

  /** Waits for a condition the server brings about, for at most two seconds. */
  async function until(condition: () => boolean) {
    for (let waited = 0; !condition(); waited += 20) {
      if (waited > 2000) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const queueEvents = (stream: Stream) =>
    stream.blocks.filter((block) => block.startsWith('event:'));

  it('says which department changed, to the hospital’s streams only, holding no connection', async () => {
    const ours = await open();
    const theirs = await open({ tenant: clinic, user: clinicDesk });
    try {
      expect(ours.status).toBe(200);
      expect(ours.contentType).toMatch(/^text\/event-stream/);
      await until(() => ours.blocks.length > 0);
      expect(ours.blocks[0]).toBe('retry: 5000');
      // An open stream holds no database connection.
      expect(pool.totalCount - pool.idleCount).toBe(0);

      await issued({ patientId: patients.one, departmentId: departments.surgery });
      await until(() => queueEvents(ours).length === 1);
      expect(queueEvents(ours)).toEqual([
        `event: queue\ndata: ${JSON.stringify({ departmentId: departments.surgery })}`,
      ]);
      // Nothing about the patient, and nothing to the other hospital.
      expect(ours.blocks.join('\n')).not.toContain(patients.one);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(queueEvents(theirs)).toEqual([]);
    } finally {
      ours.close();
      theirs.close();
    }
  });

  it('sends nothing of a change that rolled back', async () => {
    const stream = await open();
    try {
      await until(() => stream.blocks.length > 0);
      await post('/queue/tokens', {
        patientId: patients.clinic,
        departmentId: departments.general,
      });
      await issued({ patientId: patients.two, departmentId: departments.general });
      await until(() => queueEvents(stream).length === 1);
      expect(queueEvents(stream)[0]).toContain(departments.general);
    } finally {
      stream.close();
    }
  });

  it('passes on only the department a scope of department reaches', async () => {
    await pool.query(
      "update role_permissions set scope = 'department' where tenant_id = $1 and role_id = 'doctor' and permission = 'queue:read'",
      [hospital.id],
    );
    const stream = await open({ user: docC });
    try {
      await until(() => stream.blocks.length > 0);
      await issued({ patientId: patients.one, departmentId: departments.general });
      await issued({ patientId: patients.two, departmentId: departments.surgery });
      await until(() => queueEvents(stream).length === 1);
      expect(queueEvents(stream)[0]).toContain(departments.surgery);
    } finally {
      stream.close();
      await pool.query(
        "update role_permissions set scope = 'all' where tenant_id = $1 and role_id = 'doctor' and permission = 'queue:read'",
        [hospital.id],
      );
    }
  });

  it('ends when the caller loses queue:read, and when the hospital switches the queue off', async () => {
    const lost = await open({ user: nurse });
    await until(() => lost.blocks.length > 0);
    await without(hospital, 'nurse', 'queue:read', async () => {
      await issued({ patientId: patients.one, departmentId: departments.general });
      await until(() => lost.ended());
    });
    expect(queueEvents(lost)).toEqual([]);

    const off = await open({ user: nurse });
    await until(() => off.blocks.length > 0);
    await pool.query(
      "update tenant_features set enabled = false where tenant_id = $1 and feature = 'queue'",
      [hospital.id],
    );
    const client = await pool.connect();
    try {
      // No route answers while the module is off, so the change comes straight to the bus.
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [hospital.id]);
      await app.live.bus.publish(client, 'queue', { departmentId: departments.general });
      await client.query('commit');
      await until(() => off.ended());
      expect(queueEvents(off)).toEqual([]);
    } finally {
      client.release();
      await pool.query(
        "update tenant_features set enabled = true where tenant_id = $1 and feature = 'queue'",
        [hospital.id],
      );
    }
  });
});

describe('the live stream of a signed-in session', () => {
  let cookieApp: FastifyInstance;
  let person: TestUser;
  let base = '';

  beforeAll(async () => {
    cookieApp = await buildTestApp();
    await cookieApp.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(cookieApp.server.address() as AddressInfo).port}`;
    person = await createUser(pool, 'Queue Signed In');
    await addMembership(pool, person, hospital, 'receptionist');
  });

  afterAll(async () => {
    await cookieApp.close();
    await deleteUsers(pool, [person]);
  });

  it('ends when the session is signed out', async () => {
    const login = await cookieApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: person.email, password: person.password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const controller = new AbortController();
    const response = await fetch(`${base}/queue/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('retry:');

    const logout = await cookieApp.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBeLessThan(300);
    await issued({ patientId: patients.one, departmentId: departments.general });
    // The next change finds the session gone and ends the stream instead of passing it on.
    const next = await Promise.race([
      reader?.read(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    controller.abort();
    expect(next).toMatchObject({ done: true });
  });
});
