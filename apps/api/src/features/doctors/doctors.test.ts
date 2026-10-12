import { randomUUID } from 'node:crypto';
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
 * The doctors API through the real app and database: profiles, the staff a profile can be made
 * for, weekly working hours, versions, the hospital boundary, permissions and audit.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the doctors module switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Staff of the hospital, in name order: Asha, Bela, Chitra, Dev. Asha also works at the clinic. */
let asha: TestUser;
let bela: TestUser;
let chitra: TestUser;
let dev: TestUser;
/** A nurse: sees doctors, cannot change them. */
let nurse: TestUser;
/** No doctor permissions at all. */
let storeKeeper: TestUser;
/** Works at the clinic only. */
let clinicOnly: TestUser;
const departments: Record<string, string> = {};

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Doctor {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  departmentId: string;
  departmentName: string;
  specialization: string;
  registrationNumber?: string;
  consultationMinutes: number;
  active: boolean;
  version: number;
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface Session {
  day: string;
  start: string;
  end: string;
}
interface Availability {
  doctorId: string;
  sessions: Session[];
  version: number;
}
type Reply = { statusCode: number; json: <T = { error: { code: string } }>() => T };

const headers = ({ tenant = hospital, user = admin }: Options = {}) => as(tenant.id, user.id);
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const create = (body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url: '/doctors',
    headers: { ...headers(options), ...(options.key ? { 'idempotency-key': options.key } : {}) },
    payload: body,
  });
const change = (id: string, body: object, options: Options = {}) =>
  app.inject({ method: 'PATCH', url: `/doctors/${id}`, headers: headers(options), payload: body });
const setHours = (
  id: string,
  sessions: Session[],
  expectedVersion: number,
  options: Options = {},
) =>
  app.inject({
    method: 'PUT',
    url: `/doctors/${id}/availability`,
    headers: headers(options),
    payload: { sessions, expectedVersion },
  });
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];
const names = (response: Reply) => response.json<Page<{ name: string }>>().items.map((i) => i.name);

const profile = (user: TestUser, department = 'Cardiology', extra: object = {}) => ({
  userId: user.id,
  departmentId: departments[department],
  specialization: 'General practice',
  consultationMinutes: 15,
  ...extra,
});

/** Creates a profile and returns it. */
async function doctorFor(user: TestUser, department?: string, options: Options = {}) {
  const response = await create(profile(user, department), options);
  if (response.statusCode !== 201) throw new Error(`could not create a profile in test setup`);
  return response.json<Doctor>();
}

const audited = async (tenant: TestTenant, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      `select action from audit_log
       where tenant_id = $1 and entity = 'doctor' and entity_id = $2 order by at`,
      [tenant.id, entityId],
    )
  ).rows.map((row) => row.action);

/** Removes every profile, so each group of tests starts from its own. */
const clearDoctors = () =>
  pool.query('delete from doctors where tenant_id = any($1)', [
    [hospital.id, clinic.id, closed.id],
  ]);

async function addDepartment(tenant: TestTenant, name: string, archived = false) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name, archived) values ($1, $2, $3) returning id',
    [tenant.id, name, archived],
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { departments: true, doctors: true };
  hospital = await createTenant(pool, 'Doctors Hospital', { features });
  clinic = await createTenant(pool, 'Doctors Clinic', { features });
  closed = await createTenant(pool, 'Doctors Closed', {
    features: { ...features, doctors: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Doctors Admin');
  asha = await user('Asha Rao');
  bela = await user('Bela Shah');
  chitra = await user('Chitra Iyer');
  dev = await user('Dev Nair');
  nurse = await user('Nurse Nila');
  storeKeeper = await user('Store Sam');
  clinicOnly = await user('Clinic Only');
  for (const tenant of [hospital, clinic, closed])
    await addMembership(pool, admin, tenant, 'admin');
  for (const doctor of [asha, bela, chitra, dev])
    await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, asha, clinic, 'doctor');
  await addMembership(pool, clinicOnly, clinic, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');
  departments.Cardiology = await addDepartment(hospital, 'Cardiology');
  departments.Neurology = await addDepartment(hospital, 'Neurology');
  departments.Closed = await addDepartment(hospital, 'Closed Ward', true);
  departments.Family = await addDepartment(clinic, 'Family Medicine');
});

afterAll(async () => {
  await clearDoctors();
  await pool.query('delete from departments where tenant_id = any($1)', [
    [hospital.id, clinic.id, closed.id],
  ]);
  await deleteUsers(pool, [admin, asha, bela, chitra, dev, nurse, storeKeeper, clinicOnly]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

afterEach(async () => {
  await pool.query("update memberships set status = 'active' where tenant_id = any($1)", [
    [hospital.id, clinic.id, closed.id],
  ]);
});

/** A change that the test relies on having gone through. */
async function changed(id: string, body: object, options: Options = {}) {
  const response = await change(id, body, options);
  if (response.statusCode !== 200) throw new Error('a change did not go through in a test');
  return response.json<Doctor>();
}

describe('creating a profile', () => {
  beforeAll(clearDoctors);

  it('makes a member of staff a doctor in a department of the hospital', async () => {
    const response = await create(
      profile(asha, 'Cardiology', {
        specialization: '  Electrophysiology ',
        registrationNumber: ' MCI-1 ',
      }),
    );

    expect(response.statusCode).toBe(201);
    const doctor = response.json<Doctor>();
    expect(doctor).toEqual({
      id: expect.any(String),
      tenantId: hospital.id,
      userId: asha.id,
      name: 'Asha Rao',
      departmentId: departments.Cardiology,
      departmentName: 'Cardiology',
      specialization: 'Electrophysiology',
      registrationNumber: 'MCI-1',
      consultationMinutes: 15,
      active: true,
      version: 1,
    });
    expect(await audited(hospital, doctor.id)).toEqual(['create']);
    // No working hours yet.
    const hours = await get(`/doctors/${doctor.id}/availability`);
    expect(hours.json()).toEqual({ doctorId: doctor.id, sessions: [], version: 1 });
  });

  it('refuses a second profile for the same person', async () => {
    expect(errorOf(await create(profile(asha, 'Neurology')))).toEqual([409, 'doctor_exists']);
  });

  it('refuses someone who is not an active member here, and a department that is not usable', async () => {
    await pool.query(
      "update memberships set status = 'suspended' where user_id = $1 and tenant_id = $2",
      [dev.id, hospital.id],
    );
    const refused = [
      profile(clinicOnly),
      profile(dev),
      { ...profile(bela), userId: randomUUID() },
      { ...profile(bela), userId: 'not-an-id' },
      profile(bela, 'Family'),
      profile(bela, 'Closed'),
      { ...profile(bela), departmentId: randomUUID() },
    ];
    for (const body of refused) {
      expect(errorOf(await create(body)), JSON.stringify(body)).toEqual([400, 'validation_failed']);
    }
    await pool.query("update memberships set status = 'active' where user_id = $1", [dev.id]);
    const { rows } = await pool.query('select 1 from doctors where tenant_id = $1', [hospital.id]);
    expect(rows).toHaveLength(1);
  });

  it('needs every field in range, and takes no hospital from the body', async () => {
    const good = profile(bela);
    for (const body of [
      { ...good, specialization: '   ' },
      { ...good, specialization: 'x'.repeat(101) },
      { ...good, consultationMinutes: 4 },
      { ...good, consultationMinutes: 121 },
      { ...good, consultationMinutes: 12.5 },
      { ...good, registrationNumber: 'x'.repeat(51) },
      { userId: bela.id },
    ]) {
      expect((await create(body)).statusCode, JSON.stringify(body)).toBe(400);
    }

    // A hospital named in the body is not read: the profile is the session's hospital's.
    const response = await create({ ...good, tenantId: clinic.id });
    expect(response.statusCode).toBe(201);
    expect(response.json<Doctor>().tenantId).toBe(hospital.id);
    const { rows } = await pool.query('select 1 from doctors where tenant_id = $1', [clinic.id]);
    expect(rows).toHaveLength(0);
  });

  it('answers a repeat of the same request with the same profile', async () => {
    const key = `key-${randomUUID()}`;
    const first = await create(profile(chitra), { key });
    const again = await create(profile(chitra), { key });

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Doctor>().id).toBe(first.json<Doctor>().id);
  });
});

describe('who a profile can be made for', () => {
  beforeAll(async () => {
    await clearDoctors();
    await doctorFor(asha);
  });

  it('lists the hospital’s active staff who have no profile yet, by name', async () => {
    const response = await get('/doctors/candidates');

    expect(response.statusCode).toBe(200);
    const page = response.json<Page<{ userId: string; name: string; email: string }>>();
    expect(page.items.map((item) => item.name)).toEqual([
      'Bela Shah',
      'Chitra Iyer',
      'Dev Nair',
      'Doctors Admin',
      'Nurse Nila',
      'Store Sam',
    ]);
    expect(page.items[0]).toEqual({ userId: bela.id, name: 'Bela Shah', email: bela.email });
    expect(page.total).toBe(6);
  });

  it('searches the name and the address, and pages', async () => {
    expect(names(await get('/doctors/candidates?q=NAIR'))).toEqual(['Dev Nair']);
    expect(names(await get(`/doctors/candidates?q=${encodeURIComponent(chitra.email)}`))).toEqual([
      'Chitra Iyer',
    ]);

    const first = await get('/doctors/candidates?limit=4');
    const cursor = encodeURIComponent(first.json<Page<unknown>>().nextCursor ?? '');
    const second = await get(`/doctors/candidates?limit=4&cursor=${cursor}`);
    expect(names(second)).toEqual(['Nurse Nila', 'Store Sam']);
    expect(second.json<Page<unknown>>().nextCursor).toBeNull();
  });

  it('leaves out someone who was deactivated', async () => {
    await pool.query(
      "update memberships set status = 'suspended' where user_id = $1 and tenant_id = $2",
      [dev.id, hospital.id],
    );
    expect(names(await get('/doctors/candidates'))).not.toContain('Dev Nair');
    await pool.query("update memberships set status = 'active' where user_id = $1", [dev.id]);
  });
});

describe('the list and a profile', () => {
  let ashaDoctor: Doctor;
  let belaDoctor: Doctor;

  beforeAll(async () => {
    await clearDoctors();
    ashaDoctor = await doctorFor(asha, 'Cardiology');
    belaDoctor = await doctorFor(bela, 'Neurology');
    await doctorFor(chitra, 'Cardiology');
    const gone = await doctorFor(dev, 'Neurology');
    await changed(gone.id, { active: false, expectedVersion: 1 });
    await changed(belaDoctor.id, { specialization: 'Stroke medicine', expectedVersion: 1 });
  });

  it('lists the active doctors by name, a page at a time', async () => {
    const first = await get('/doctors?limit=2');
    expect(names(first)).toEqual(['Asha Rao', 'Bela Shah']);
    expect(first.json<Page<Doctor>>().total).toBe(3);

    const cursor = encodeURIComponent(first.json<Page<Doctor>>().nextCursor ?? '');
    const second = await get(`/doctors?limit=2&cursor=${cursor}`);
    expect(names(second)).toEqual(['Chitra Iyer']);
    expect(second.json<Page<Doctor>>().nextCursor).toBeNull();
    expect(errorOf(await get('/doctors?cursor=nonsense'))).toEqual([400, 'invalid_cursor']);
  });

  it('narrows by department, by name or specialization, and to inactive doctors', async () => {
    expect(names(await get(`/doctors?departmentId=${departments.Cardiology}`))).toEqual([
      'Asha Rao',
      'Chitra Iyer',
    ]);
    expect(names(await get('/doctors?q=stroke'))).toEqual(['Bela Shah']);
    expect(names(await get('/doctors?q=chitra'))).toEqual(['Chitra Iyer']);
    expect(names(await get('/doctors?active=false'))).toEqual(['Dev Nair']);
    // Not an id of anything, and another hospital's department: nobody.
    expect(names(await get('/doctors?departmentId=nonsense'))).toEqual([]);
    expect(names(await get(`/doctors?departmentId=${departments.Family}`))).toEqual([]);
    expect((await get('/doctors?q=%00')).statusCode).toBe(400);
  });

  it('reads one profile', async () => {
    const response = await get(`/doctors/${ashaDoctor.id}`);

    expect(response.json()).toMatchObject({
      id: ashaDoctor.id,
      name: 'Asha Rao',
      departmentName: 'Cardiology',
    });
  });

  it('saves a change from the version that was read, and refuses one from an older version', async () => {
    const response = await change(ashaDoctor.id, {
      departmentId: departments.Neurology,
      specialization: 'Epilepsy',
      registrationNumber: 'MCI-9',
      consultationMinutes: 25,
      expectedVersion: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      departmentName: 'Neurology',
      specialization: 'Epilepsy',
      registrationNumber: 'MCI-9',
      consultationMinutes: 25,
      version: 2,
    });
    expect(
      errorOf(await change(ashaDoctor.id, { specialization: 'Old', expectedVersion: 1 })),
    ).toEqual([409, 'conflict']);
    expect(await audited(hospital, ashaDoctor.id)).toEqual(['create', 'update']);
  });

  it('writes nothing when what is sent is what the profile already has', async () => {
    const same = await change(ashaDoctor.id, { specialization: ' Epilepsy ', expectedVersion: 2 });

    expect(same.json()).toMatchObject({ version: 2 });
    expect(await audited(hospital, ashaDoctor.id)).toEqual(['create', 'update']);
  });

  it('does not move a doctor into a department that is archived or another hospital’s', async () => {
    for (const departmentId of [departments.Closed, departments.Family, randomUUID(), 'nonsense']) {
      const response = await change(ashaDoctor.id, { departmentId, expectedVersion: 2 });
      expect(errorOf(response), departmentId).toEqual([400, 'validation_failed']);
    }
  });

  it('lets a doctor stay in a department that was archived since', async () => {
    await pool.query('update departments set archived = true where id = $1', [
      departments.Neurology,
    ]);

    const response = await change(ashaDoctor.id, { consultationMinutes: 30, expectedVersion: 2 });

    expect(response.json()).toMatchObject({ departmentName: 'Neurology', version: 3 });
    await pool.query('update departments set archived = false where id = $1', [
      departments.Neurology,
    ]);
  });

  it('removes a registration number that is sent empty, and makes a profile inactive and active', async () => {
    const cleared = await change(ashaDoctor.id, { registrationNumber: '', expectedVersion: 3 });
    expect(cleared.json<Doctor>().registrationNumber).toBeUndefined();

    const inactive = await change(ashaDoctor.id, { active: false, expectedVersion: 4 });
    expect(inactive.json()).toMatchObject({ active: false, version: 5 });
    expect(names(await get('/doctors'))).not.toContain('Asha Rao');
    const back = await change(ashaDoctor.id, { active: true, expectedVersion: 5 });
    expect(back.json()).toMatchObject({ active: true, version: 6 });
  });

  it('counts a doctor whose membership was deactivated as inactive, until the member is back', async () => {
    const suspend = (status: string) =>
      pool.query('update memberships set status = $3 where user_id = $1 and tenant_id = $2', [
        chitra.id,
        hospital.id,
        status,
      ]);
    const chitraDoctor = (await get('/doctors?q=chitra')).json<Page<Doctor>>().items[0] as Doctor;
    await suspend('suspended');

    // Not among the doctors scheduling would offer, and shown as not practising.
    expect(names(await get('/doctors'))).not.toContain('Chitra Iyer');
    expect(names(await get('/doctors?active=false'))).toContain('Chitra Iyer');
    expect((await get(`/doctors/${chitraDoctor.id}`)).json()).toMatchObject({ active: false });

    // The profile itself was not touched, so the member coming back is all it takes.
    await suspend('active');
    expect(names(await get('/doctors'))).toContain('Chitra Iyer');
    expect((await get(`/doctors/${chitraDoctor.id}`)).json()).toMatchObject({
      active: true,
      version: chitraDoctor.version,
    });
  });

  it('does not make a profile active for someone who no longer works here', async () => {
    const gone = (await get('/doctors?active=false&q=dev')).json<Page<Doctor>>().items[0] as Doctor;
    await pool.query(
      "update memberships set status = 'suspended' where user_id = $1 and tenant_id = $2",
      [dev.id, hospital.id],
    );

    const refused = await change(gone.id, { active: true, expectedVersion: gone.version });

    expect(errorOf(refused)).toEqual([400, 'validation_failed']);
    await pool.query("update memberships set status = 'active' where user_id = $1", [dev.id]);
    const allowed = await change(gone.id, { active: true, expectedVersion: gone.version });
    expect(allowed.json()).toMatchObject({ active: true });
    await change(gone.id, { active: false, expectedVersion: allowed.json<Doctor>().version });
  });

  it('lets one of two changes made from the same version through', async () => {
    const version = (await get(`/doctors/${belaDoctor.id}`)).json<Doctor>().version;

    const results = await Promise.all([
      change(belaDoctor.id, { consultationMinutes: 20, expectedVersion: version }),
      change(belaDoctor.id, { consultationMinutes: 40, expectedVersion: version }),
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });
});

describe('working hours', () => {
  let doctor: Doctor;
  const morning = { day: 'mon', start: '09:00', end: '13:00' };

  beforeAll(async () => {
    await clearDoctors();
    doctor = await doctorFor(asha);
  });

  it('replaces the week, in order, and counts its own version', async () => {
    const response = await setHours(
      doctor.id,
      [
        { day: 'sat', start: '10:00', end: '12:30' },
        { day: 'mon', start: '17:00', end: '20:00' },
        morning,
      ],
      1,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      doctorId: doctor.id,
      sessions: [
        morning,
        { day: 'mon', start: '17:00', end: '20:00' },
        { day: 'sat', start: '10:00', end: '12:30' },
      ],
      version: 2,
    });
    expect((await get(`/doctors/${doctor.id}/availability`)).json()).toEqual(response.json());
    // The profile was not changed, and its version says so.
    expect((await get(`/doctors/${doctor.id}`)).json<Doctor>().version).toBe(1);
    expect(await audited(hospital, doctor.id)).toEqual(['create', 'update_hours']);
  });

  it('lets one session end when the next begins', async () => {
    const response = await setHours(
      doctor.id,
      [morning, { day: 'mon', start: '13:00', end: '17:00' }],
      2,
    );

    expect(response.json<Availability>()).toMatchObject({ version: 3 });
  });

  it('refuses hours that overlap, end before they start, or are not times of a day of the week', async () => {
    const bad: Session[][] = [
      [morning, { day: 'mon', start: '12:59', end: '14:00' }],
      [{ day: 'tue', start: '13:00', end: '13:00' }],
      [{ day: 'tue', start: '14:00', end: '09:00' }],
      [{ day: 'tue', start: '24:00', end: '25:00' }],
      [{ day: 'tue', start: '9:00', end: '13:00' }],
      [{ day: 'someday', start: '09:00', end: '13:00' }],
    ];
    for (const sessions of bad) {
      expect((await setHours(doctor.id, sessions, 3)).statusCode, JSON.stringify(sessions)).toBe(
        400,
      );
    }
    expect((await get(`/doctors/${doctor.id}/availability`)).json<Availability>().version).toBe(3);
  });

  it('refuses a change made from an older version, and writes nothing for the same hours', async () => {
    expect(errorOf(await setHours(doctor.id, [morning], 2))).toEqual([409, 'conflict']);

    const same = await setHours(
      doctor.id,
      [{ day: 'mon', start: '13:00', end: '17:00' }, morning],
      3,
    );
    expect(same.json<Availability>().version).toBe(3);
    expect(await audited(hospital, doctor.id)).toEqual(['create', 'update_hours', 'update_hours']);
  });

  it('lets one of two replacements made from the same version through', async () => {
    const version = (await get(`/doctors/${doctor.id}/availability`)).json<Availability>().version;

    const results = await Promise.all([
      setHours(doctor.id, [{ day: 'thu', start: '09:00', end: '12:00' }], version),
      setHours(doctor.id, [{ day: 'thu', start: '14:00', end: '18:00' }], version),
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const now = (await get(`/doctors/${doctor.id}/availability`)).json<Availability>();
    expect(now.version).toBe(version + 1);
    expect(now.sessions).toHaveLength(1);
    // Back to what the tests after this one expect.
    const restored = await setHours(
      doctor.id,
      [morning, { day: 'mon', start: '13:00', end: '17:00' }],
      now.version,
    );
    expect(restored.statusCode).toBe(200);
  });

  it('is unaffected by a change to the profile', async () => {
    const hours = () => get(`/doctors/${doctor.id}/availability`);
    const before = (await hours()).json<Availability>().version;
    await changed(doctor.id, { consultationMinutes: 45, expectedVersion: 1 });

    expect((await hours()).json<Availability>().version).toBe(before);
    // And an empty week is a week off.
    expect((await setHours(doctor.id, [], before)).json()).toEqual({
      doctorId: doctor.id,
      sessions: [],
      version: before + 1,
    });
  });

  it('is kept from overlapping by the database itself', async () => {
    const insert = (start: number, end: number) =>
      pool.query(
        'insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute) values ($1, $2, 3, $3, $4)',
        [hospital.id, doctor.id, start, end],
      );
    await insert(540, 780);

    await expect(insert(700, 900)).rejects.toThrow(/doctor_hours_no_overlap/);
    await expect(insert(780, 900)).resolves.toBeDefined();

    // The rule looks at one hospital at a time: the same doctor id and hours under another
    // hospital are refused for the hospital they name (the foreign key), not for overlapping.
    await expect(
      pool.query(
        'insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute) values ($1, $2, 3, 540, 780)',
        [clinic.id, doctor.id],
      ),
    ).rejects.toThrow(/doctor_hours_doctor/);
  });
});

describe('access', () => {
  let doctor: Doctor;

  beforeAll(async () => {
    await clearDoctors();
    doctor = await doctorFor(asha);
  });

  it('lets someone who may only read see doctors and hours, and change nothing', async () => {
    const options = { user: nurse };

    expect((await get('/doctors', options)).statusCode).toBe(200);
    expect((await get(`/doctors/${doctor.id}`, options)).statusCode).toBe(200);
    expect((await get(`/doctors/${doctor.id}/availability`, options)).statusCode).toBe(200);
    for (const response of [
      await get('/doctors/candidates', options),
      await create(profile(bela), options),
      await change(doctor.id, { active: false, expectedVersion: 1 }, options),
      await setHours(doctor.id, [], 1, options),
    ]) {
      expect(errorOf(response)).toEqual([403, 'permission_denied']);
    }
  });

  it('shows nothing to a role without the permission, or to nobody', async () => {
    expect(errorOf(await get('/doctors', { user: storeKeeper }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect((await app.inject({ url: '/doctors' })).statusCode).toBe(401);
  });

  it('does not exist for a hospital with the module off', async () => {
    const options = { tenant: closed };

    expect(errorOf(await get('/doctors', options))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await get('/doctors/candidates', options))).toEqual([403, 'feature_disabled']);
  });
});

describe('two hospitals', () => {
  let ours: Doctor;
  let theirs: Doctor;

  beforeAll(async () => {
    await clearDoctors();
    ours = await doctorFor(asha, 'Cardiology');
    // The same person is a doctor at the clinic too, with a profile of the clinic's own.
    theirs = await doctorFor(asha, 'Family', { tenant: clinic });
    await setHours(theirs.id, [{ day: 'fri', start: '08:00', end: '12:00' }], 1, {
      tenant: clinic,
    });
  });

  it('keeps each hospital’s doctors to itself', async () => {
    expect(theirs.tenantId).toBe(clinic.id);
    expect(theirs.id).not.toBe(ours.id);

    const here = (await get('/doctors')).json<Page<Doctor>>().items;
    expect(here.map((item) => item.id)).toEqual([ours.id]);
    const there = (await get('/doctors', { tenant: clinic })).json<Page<Doctor>>().items;
    expect(there.map((item) => item.id)).toEqual([theirs.id]);
    expect(names(await get('/doctors/candidates', { tenant: clinic }))).toEqual([
      'Clinic Only',
      'Doctors Admin',
    ]);
  });

  it('has one answer for another hospital’s doctor and one that does not exist', async () => {
    for (const id of [theirs.id, randomUUID(), 'not-an-id']) {
      expect(errorOf(await get(`/doctors/${id}`)), id).toEqual([404, 'doctor_not_found']);
      expect(errorOf(await get(`/doctors/${id}/availability`)), id).toEqual([
        404,
        'doctor_not_found',
      ]);
      expect(errorOf(await change(id, { active: false, expectedVersion: 1 })), id).toEqual([
        404,
        'doctor_not_found',
      ]);
      expect(errorOf(await setHours(id, [], 2)), id).toEqual([404, 'doctor_not_found']);
    }
    const hours = await get(`/doctors/${theirs.id}/availability`, { tenant: clinic });
    expect(hours.json<Availability>().sessions).toHaveLength(1);
  });

  it('is kept apart by the database itself, whatever the SQL', async () => {
    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      doctors: (await client.query<{ tenant_id: string }>('select distinct tenant_id from doctors'))
        .rows,
      hours: (await client.query('select 1 from doctor_hours where doctor_id = $1', [theirs.id]))
        .rowCount,
      updated: (await client.query('update doctors set active = false where id = $1', [theirs.id]))
        .rowCount,
      cleared: (await client.query('delete from doctor_hours where doctor_id = $1', [theirs.id]))
        .rowCount,
    }));
    expect(seen).toEqual({
      doctors: [{ tenant_id: hospital.id }],
      hours: 0,
      updated: 0,
      cleared: 0,
    });

    await expect(
      asTenantSql(pool, hospital.id, (client) => client.query('delete from doctors')),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot hold a doctor who is not a member, or a department of another hospital', async () => {
    // As the owner, with no row-level security in the way: the foreign keys carry the hospital.
    const insert = (userId: string, departmentId: string | undefined) =>
      pool.query(
        `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
         values ($1, $2, $3, 'General practice', 15)`,
        [hospital.id, userId, departmentId],
      );

    await expect(insert(clinicOnly.id, departments.Cardiology)).rejects.toThrow(/doctors_member/);
    await expect(insert(bela.id, departments.Family)).rejects.toThrow(/doctors_department/);
  });
});
