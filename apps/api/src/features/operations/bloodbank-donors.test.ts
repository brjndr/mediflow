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
import { ageOn } from './blooddonors.js';
import { isCompatible } from './bloodcompat.js';

/**
 * Blood donors, collections, screening, the patient's blood group and cross-match (#585, part A):
 * the donation rules, the refusals the database makes on its own, permissions, the hospital
 * boundary and a cross-tenant row-level security check for each new table.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let nurse: TestUser;
let labTech: TestUser;
let pharmacist: TestUser;
let clinicAdmin: TestUser;
let patientId: string;
let clinicPatientId: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Unit {
  id: string;
  status: string;
  screeningStatus: string;
  version: number;
  patientId?: string;
}
interface Donor {
  id: string;
  donorNumber: string;
  status: string;
  deferredPermanent: boolean;
  fullName: string;
  maskedName: string;
  maskedPhone?: string;
  collections: { id: string; unitIds: string[] }[];
}
interface Collection {
  id: string;
  unitIds: string[];
}

const hour = 3_600_000;
const day = 24 * hour;
const headers = ({ tenant = hospital, user = labTech, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `bd-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    payload: body,
  });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
async function ok<Body>(response: Response, status = 200): Promise<Body> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return response.json<Body>();
}
const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);
const eventsOf = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at, id',
      [hospital.id, entityId],
    )
  ).rows.map((row) => row.event);

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
const TABLES = [
  'blood_crossmatches',
  'blood_screenings',
  'patient_blood_groups',
  'blood_unit_events',
  'blood_units',
  'blood_collections',
  'blood_donors',
];
async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of TABLES) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('delete from outbox where tenant_id = any($1)', [tenants()]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const birthYearsAgo = (years: number, extraDays = 0) =>
  new Date(Date.now() - years * 365.25 * day - extraDays * day).toISOString().slice(0, 10);

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = { bloodbank: true, patients: true };
  hospital = await createTenant(pool, 'Donor Hospital', { features: on });
  clinic = await createTenant(pool, 'Donor Clinic', { features: on });
  closed = await createTenant(pool, 'Donor Closed', { features: { bloodbank: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Donor Admin', { withPassword: false });
  nurse = await createUser(pool, 'Donor Nurse', { withPassword: false });
  labTech = await createUser(pool, 'Donor Lab', { withPassword: false });
  pharmacist = await createUser(pool, 'Donor Pharmacist', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Donor Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, labTech, hospital, 'lab_technician');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const patient = async (tenant: TestTenant, mrn: string) =>
    (
      await pool.query<{ id: string }>(
        `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
         values ($1, $2, 'Donor', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
        [tenant.id, mrn],
      )
    ).rows[0]!.id;
  patientId = await patient(hospital, 'BD-0000001');
  clinicPatientId = await patient(clinic, 'BD-0000002');
}, 60_000);

afterAll(async () => {
  try {
    await wipe();
    await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
    await deleteUsers(pool, [admin, nurse, labTech, pharmacist, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

// --- helpers -----------------------------------------------------------------------------------

let unitNo = 0;
const addDonor = (more: object = {}, options: Options = {}) =>
  post(
    '/blood/donors',
    {
      fullName: 'Ravi Kumar',
      dateOfBirth: birthYearsAgo(30),
      sex: 'male',
      bloodGroup: 'O+',
      phone: '+91 98765 43210',
      ...more,
    },
    options,
  );
const collect = (donorId: string, more: object = {}, options: Options = {}) =>
  post(
    '/blood/collections',
    {
      donorId,
      volumeMl: 450,
      units: [
        {
          unitNumber: `DU-${String(++unitNo).padStart(5, '0')}`,
          component: 'red_cells',
          volumeMl: 350,
          expiresAt: new Date(Date.now() + 35 * day).toISOString(),
        },
      ],
      ...more,
    },
    options,
  );
const negative = {
  hiv: 'negative',
  hbv: 'negative',
  hcv: 'negative',
  syphilis: 'negative',
  malaria: 'negative',
};
const unitOf = async (id: string) =>
  (await ok<{ unit: Unit }>(await get(`/blood-units/${id}`))).unit;
const move = (unit: Unit, to: string, more: object = {}, options: Options = {}) =>
  post(`/blood-units/${unit.id}/move`, { to, version: unit.version, ...more }, options);
const setGroup = (patient: string, bloodGroup: string, reason?: string, options: Options = {}) =>
  post(`/patients/${patient}/blood-group`, { bloodGroup, ...(reason ? { reason } : {}) }, options);

/** A donor, a collection and one unit, taken to `testing` (or on to `available` when cleared). */
async function unitAt(to: 'testing' | 'available', bloodGroup = 'O+', component = 'red_cells') {
  const donor = await ok<Donor>(await addDonor({ bloodGroup }), 201);
  const collection = await ok<Collection>(
    await collect(donor.id, {
      units: [
        {
          unitNumber: `DU-${String(++unitNo).padStart(5, '0')}`,
          component,
          volumeMl: 300,
          expiresAt: new Date(Date.now() + 30 * day).toISOString(),
        },
      ],
    }),
    201,
  );
  let unit = await unitOf(collection.unitIds[0] as string);
  unit = await ok<Unit>(await move(unit, 'testing'));
  if (to === 'testing') return { donor, unit };
  await ok(await post(`/blood-units/${unit.id}/screening`, negative), 201);
  unit = await unitOf(unit.id);
  unit = await ok<Unit>(await move(unit, 'available'));
  return { donor, unit };
}
const crossmatch = (unit: Unit, patient: string, result = 'compatible', options: Options = {}) =>
  post(`/blood-units/${unit.id}/crossmatch`, { patientId: patient, result }, options);

// --- donors ------------------------------------------------------------------------------------

describe('the donor rules', () => {
  it('counts age in whole years and decides compatibility by group and component', () => {
    expect(ageOn('2000-06-15', new Date('2026-06-14T00:00:00Z'))).toBe(25);
    expect(ageOn('2000-06-15', new Date('2026-06-15T00:00:00Z'))).toBe(26);
    expect(isCompatible('O-', 'AB+', 'red_cells')).toBe(true);
    expect(isCompatible('A+', 'A-', 'red_cells')).toBe(false);
    expect(isCompatible('A+', 'O+', 'whole_blood')).toBe(false);
    expect(isCompatible('AB+', 'O+', 'plasma')).toBe(true);
    expect(isCompatible('O+', 'A+', 'plasma')).toBe(false);
    expect(isCompatible('B-', 'B+', 'platelets')).toBe(true);
  });
});

describe('blood donors', () => {
  it('registers a donor of 18 to 65, with a number, an audit entry and an event', async () => {
    await wipe();
    const donor = await ok<Donor>(await addDonor(), 201);
    expect(donor.donorNumber).toMatch(/^D[0-9A-F]{8}$/);
    expect(donor).toMatchObject({ status: 'active', fullName: 'Ravi Kumar', collections: [] });
    expect(await audited('blood_donor', donor.id)).toEqual(['create']);
    expect(await eventsOf(donor.id)).toEqual(['blood.donor_registered']);
    expect(errorOf(await addDonor({ dateOfBirth: birthYearsAgo(17) }))).toEqual([422, 'donor_age']);
    expect(errorOf(await addDonor({ dateOfBirth: birthYearsAgo(66, 5) }))).toEqual([
      422,
      'donor_age',
    ]);
    await ok(await addDonor({ dateOfBirth: birthYearsAgo(18, 3) }), 201);
    await ok(await addDonor({ dateOfBirth: birthYearsAgo(65) }), 201);
  });

  it('lists donors masked, searched from the body, and shows one in full as an audited read', async () => {
    await wipe();
    const donor = await ok<Donor>(await addDonor({ fullName: 'Sunita Verma' }), 201);
    await ok(await addDonor({ fullName: 'Arjun Rao', bloodGroup: 'B-' }), 201);
    const found = await ok<{ items: Donor[]; nextCursor: string | null }>(
      await post('/blood/donors/search', { q: 'sunita' }),
    );
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ id: donor.id });
    expect(found.items[0]?.maskedName).toBe('S•••• V••••');
    expect(found.items[0]?.maskedPhone).toMatch(/3210$/);
    expect(JSON.stringify(found)).not.toContain('Sunita');
    expect(JSON.stringify(found)).not.toContain('98765');
    const byNumber = await ok<{ items: Donor[] }>(
      await post('/blood/donors/search', { q: donor.donorNumber }),
    );
    expect(byNumber.items.map((item) => item.id)).toEqual([donor.id]);
    const byGroup = await ok<{ items: Donor[] }>(
      await post('/blood/donors/search', { bloodGroup: 'B-' }),
    );
    expect(byGroup.items).toHaveLength(1);
    const paged = await ok<{ items: Donor[]; nextCursor: string | null }>(
      await post('/blood/donors/search', { limit: 1 }),
    );
    expect(paged.nextCursor).not.toBeNull();
    const full = await ok<Donor>(await get(`/blood/donors/${donor.id}`));
    expect(full.fullName).toBe('Sunita Verma');
    expect(await audited('blood_donor', donor.id)).toEqual(['create', 'read']);
    expect(errorOf(await get('/blood/donors/not-a-uuid'))).toEqual([404, 'blood_donor_not_found']);
  });

  it('keeps the donation interval and refuses a deferred donor', async () => {
    await wipe();
    const donor = await ok<Donor>(await addDonor(), 201);
    const first = await ok<Collection>(await collect(donor.id), 201);
    expect(first.unitIds).toHaveLength(1);
    expect(errorOf(await collect(donor.id))).toEqual([422, 'donation_too_soon']);
    const later = new Date(Date.now() + 91 * day);
    expect(errorOf(await collect(donor.id, { collectedAt: later.toISOString() }))).toEqual([
      422,
      'invalid_period',
    ]);
    const old = await ok<Donor>(await addDonor(), 201);
    await ok(
      await collect(old.id, { collectedAt: new Date(Date.now() - 100 * day).toISOString() }),
      201,
    );
    await ok(await collect(old.id), 201);
    const other = await ok<Donor>(await addDonor(), 201);
    const deferred = await ok<Donor>(
      await post(`/blood/donors/${other.id}/defer`, {
        reason: 'Low haemoglobin',
        until: new Date(Date.now() + 14 * day).toISOString(),
      }),
    );
    expect(deferred.status).toBe('deferred');
    expect(errorOf(await collect(other.id))).toEqual([422, 'donor_deferred']);
    expect(
      errorOf(
        await post(`/blood/donors/${other.id}/defer`, {
          reason: 'Again',
          until: new Date(Date.now() + 7 * day).toISOString(),
        }),
      ),
    ).toEqual([409, 'already_deferred']);
    expect(await eventsOf(other.id)).toEqual(['blood.donor_registered', 'blood.donor_deferred']);
    const permanent = await ok<Donor>(
      await post(`/blood/donors/${other.id}/defer`, { reason: 'Medical advice' }),
    );
    expect(permanent.deferredPermanent).toBe(true);
    expect(errorOf(await post(`/blood/donors/${other.id}/defer`, { reason: 'Twice' }))).toEqual([
      409,
      'already_deferred',
    ]);
    const deferredList = await ok<{ items: Donor[] }>(
      await post('/blood/donors/search', { status: 'deferred' }),
    );
    expect(deferredList.items.map((item) => item.id)).toEqual([other.id]);
  });

  it('records a collection with units of the donor’s group, awaiting screening', async () => {
    await wipe();
    const donor = await ok<Donor>(await addDonor({ bloodGroup: 'A-' }), 201);
    const number = `DUP-${++unitNo}`;
    const collection = await ok<Collection>(
      await collect(donor.id, {
        units: [
          {
            unitNumber: number,
            component: 'plasma',
            volumeMl: 200,
            expiresAt: new Date(Date.now() + 365 * day).toISOString(),
          },
          {
            unitNumber: `${number}-B`,
            component: 'red_cells',
            volumeMl: 250,
            expiresAt: new Date(Date.now() + 35 * day).toISOString(),
          },
        ],
      }),
      201,
    );
    expect(collection.unitIds).toHaveLength(2);
    for (const id of collection.unitIds) {
      expect(await unitOf(id)).toMatchObject({ status: 'collected', screeningStatus: 'pending' });
    }
    const unit = await ok<{ unit: { bloodGroup: string }; history: unknown[] }>(
      await get(`/blood-units/${collection.unitIds[0]}`),
    );
    expect(unit.unit.bloodGroup).toBe('A-');
    expect(unit.history).toHaveLength(1);
    expect(await audited('blood_collection', collection.id)).toEqual(['create']);
    expect(await eventsOf(collection.id)).toEqual(['blood.collection_recorded']);
    const full = await ok<Donor>(await get(`/blood/donors/${donor.id}`));
    expect(full.collections).toEqual([
      expect.objectContaining({
        id: collection.id,
        unitIds: expect.arrayContaining(collection.unitIds),
      }),
    ]);
    const second = await ok<Donor>(await addDonor(), 201);
    expect(
      errorOf(
        await collect(second.id, {
          units: [
            {
              unitNumber: number,
              component: 'plasma',
              volumeMl: 200,
              expiresAt: new Date(Date.now() + 365 * day).toISOString(),
            },
          ],
        }),
      ),
    ).toEqual([409, 'duplicate_unit']);
    expect(
      errorOf(
        await collect(second.id, {
          units: [
            {
              unitNumber: `LATE-${++unitNo}`,
              component: 'plasma',
              volumeMl: 200,
              expiresAt: new Date(Date.now() - day).toISOString(),
            },
          ],
        }),
      ),
    ).toEqual([422, 'invalid_period']);
    expect(errorOf(await collect('2d6f1f4e-0000-4000-8000-000000000000'))).toEqual([
      404,
      'blood_donor_not_found',
    ]);
  });

  it('is for the bank only: permissions, the hospital switch and the hospital boundary', async () => {
    await wipe();
    const donor = await ok<Donor>(await addDonor(), 201);
    expect(errorOf(await get(`/blood/donors/${donor.id}`, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect((await post('/blood/donors/search', {}, { user: pharmacist })).statusCode).toBe(403);
    expect((await addDonor({}, { user: nurse })).statusCode).toBe(403);
    expect(
      errorOf(await get(`/blood/donors/${donor.id}`, { tenant: closed, user: admin })),
    ).toEqual([403, 'feature_disabled']);
    expect(
      errorOf(await get(`/blood/donors/${donor.id}`, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'blood_donor_not_found']);
    const otherList = await ok<{ items: unknown[] }>(
      await post('/blood/donors/search', {}, { tenant: clinic, user: clinicAdmin }),
    );
    expect(otherList.items).toEqual([]);
  });
});

// --- screening ---------------------------------------------------------------------------------

describe('screening', () => {
  it('clears a unit, which can then be made available but not before', async () => {
    await wipe();
    const { unit } = await unitAt('testing');
    expect(errorOf(await move(unit, 'available'))).toEqual([409, 'screening_required']);
    const screening = await ok<{ id: string; outcome: string; hiv: string }>(
      await post(`/blood-units/${unit.id}/screening`, negative),
      201,
    );
    expect(screening).toMatchObject({ outcome: 'cleared', hiv: 'negative' });
    const cleared = await unitOf(unit.id);
    expect(cleared).toMatchObject({ status: 'testing', screeningStatus: 'cleared' });
    expect(await audited('blood_screening', screening.id)).toEqual(['create']);
    expect(errorOf(await post(`/blood-units/${unit.id}/screening`, negative))).toEqual([
      409,
      'already_screened',
    ]);
    expect((await move(cleared, 'available')).statusCode).toBe(200);
    expect(await eventsOf(unit.id)).toEqual(
      expect.arrayContaining(['blood.unit_screened', 'blood.unit_status_changed']),
    );
    const read = await ok<{ outcome: string }>(await get(`/blood-units/${unit.id}/screening`));
    expect(read.outcome).toBe('cleared');
  });

  it('discards a unit with a reactive result and defers its donor for good', async () => {
    await wipe();
    const { donor, unit } = await unitAt('testing');
    const result = await ok<{ id: string; outcome: string }>(
      await post(`/blood-units/${unit.id}/screening`, { ...negative, hbv: 'reactive' }),
      201,
    );
    expect(result.outcome).toBe('reactive');
    expect(await audited('blood_screening', result.id)).toEqual(['create']);
    const detail = await ok<{ unit: Unit; history: { toStatus: string; reason?: string }[] }>(
      await get(`/blood-units/${unit.id}`),
    );
    expect(detail.unit).toMatchObject({ status: 'discarded', screeningStatus: 'reactive' });
    expect(detail.history.at(-1)).toMatchObject({
      toStatus: 'discarded',
      reason: 'Reactive screening',
    });
    const after = await ok<Donor>(await get(`/blood/donors/${donor.id}`));
    expect(after).toMatchObject({ status: 'deferred', deferredPermanent: true });
    expect(await eventsOf(donor.id)).toEqual(['blood.donor_registered', 'blood.donor_deferred']);
    expect(errorOf(await collect(donor.id))).toEqual([422, 'donor_deferred']);
    // The event carries the outcome, never which test.
    const events = await pool.query<{ payload: Record<string, unknown> }>(
      "select payload from outbox where tenant_id = $1 and entity_id = $2 and event = 'blood.unit_screened'",
      [hospital.id, unit.id],
    );
    expect(events.rows[0]?.payload).toEqual({ outcome: 'reactive' });
  });

  it('is made while the unit is in testing, by the bank', async () => {
    await wipe();
    const donor = await ok<Donor>(await addDonor(), 201);
    const collection = await ok<Collection>(await collect(donor.id), 201);
    const id = collection.unitIds[0] as string;
    expect(errorOf(await post(`/blood-units/${id}/screening`, negative))).toEqual([
      409,
      'not_in_testing',
    ]);
    expect((await post(`/blood-units/${id}/screening`, negative, { user: nurse })).statusCode).toBe(
      403,
    );
    expect(errorOf(await post('/blood-units/nope/screening', negative))).toEqual([
      404,
      'blood_unit_not_found',
    ]);
    expect(errorOf(await get(`/blood-units/${id}/screening`))).toEqual([
      404,
      'blood_screening_not_found',
    ]);
  });

  it('is enforced by the database too', async () => {
    await wipe();
    const { unit } = await unitAt('testing');
    // Neither the clearance nor the move to available can be written around the screening.
    await expect(
      pool.query("update blood_units set screening_status = 'cleared' where id = $1", [unit.id]),
    ).rejects.toThrow(/Only a screening sets the screening status/);
    await expect(
      pool.query("update blood_units set status = 'available' where id = $1", [unit.id]),
    ).rejects.toThrow(/not cleared by screening/);
    await expect(
      pool.query(
        `insert into blood_units (tenant_id, unit_number, blood_group, component, volume_ml, collected_at,
                                  expires_at, created_by, screening_status)
         values ($1, 'SNEAK-1', 'O+', 'red_cells', 300, now(), now() + interval '1 day', $2, 'cleared')`,
        [hospital.id, labTech.id],
      ),
    ).rejects.toThrow(/not yet screened/);
    await ok(
      await post(`/blood-units/${unit.id}/screening`, { ...negative, hiv: 'reactive' }),
      201,
    );
    await expect(
      pool.query(
        `insert into blood_screenings (tenant_id, blood_unit_id, hiv, hbv, hcv, syphilis, malaria, screened_by)
         values ($1, $2, 'negative', 'negative', 'negative', 'negative', 'negative', $3)`,
        [hospital.id, unit.id, labTech.id],
      ),
    ).rejects.toThrow();
  });
});

// --- blood group -------------------------------------------------------------------------------

describe('the patient’s blood group', () => {
  it('is recorded as entries, a change needs a reason and the same group changes nothing', async () => {
    await wipe();
    const first = await ok<{ bloodGroup: string; history: unknown[] }>(
      await setGroup(patientId, 'O+'),
    );
    expect(first).toMatchObject({ bloodGroup: 'O+' });
    expect(first.history).toHaveLength(1);
    expect(
      (await ok<{ history: unknown[] }>(await setGroup(patientId, 'O+'))).history,
    ).toHaveLength(1);
    expect(errorOf(await setGroup(patientId, 'A+'))).toEqual([422, 'reason_required']);
    const changed = await ok<{ bloodGroup: string; history: { reason?: string }[] }>(
      await setGroup(patientId, 'A+', 'Typed again on a second sample'),
    );
    expect(changed.bloodGroup).toBe('A+');
    expect(changed.history.map((entry) => entry.reason)).toEqual([
      'Typed again on a second sample',
      undefined,
    ]);
    const read = await ok<{ bloodGroup: string }>(await get(`/patients/${patientId}/blood-group`));
    expect(read.bloodGroup).toBe('A+');
    expect(await audited('patient_blood_group', patientId)).toEqual(['update', 'update', 'read']);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update patient_blood_groups set blood_group = 'B+'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('is for patients the caller may read, and for the right people', async () => {
    await wipe();
    expect(errorOf(await setGroup(clinicPatientId, 'O+'))).toEqual([422, 'unknown_patient']);
    expect(errorOf(await get(`/patients/${clinicPatientId}/blood-group`))).toEqual([
      422,
      'unknown_patient',
    ]);
    expect((await setGroup(patientId, 'O+', undefined, { user: nurse })).statusCode).toBe(403);
    expect((await get(`/patients/${patientId}/blood-group`, { user: pharmacist })).statusCode).toBe(
      403,
    );
    await ok(await setGroup(patientId, 'O+'));
    expect((await get(`/patients/${patientId}/blood-group`, { user: nurse })).statusCode).toBe(200);
    expect(
      errorOf(await get(`/patients/${patientId}/blood-group`, { tenant: closed, user: admin })),
    ).toEqual([403, 'feature_disabled']);
  });
});

// --- cross-match -------------------------------------------------------------------------------

describe('cross-match', () => {
  it('is needed before reserving, and a compatible one lets the unit be reserved', async () => {
    await wipe();
    await ok(await setGroup(patientId, 'O+'));
    const { unit } = await unitAt('available');
    expect(errorOf(await move(unit, 'reserved', { patientId }, { user: nurse }))).toEqual([
      409,
      'crossmatch_required',
    ]);
    const match = await ok<{ id: string; result: string; validUntil: string; performedAt: string }>(
      await crossmatch(unit, patientId),
      201,
    );
    expect(match.result).toBe('compatible');
    expect(Date.parse(match.validUntil) - Date.parse(match.performedAt)).toBe(72 * hour);
    expect(await audited('blood_crossmatch', match.id)).toEqual(['create']);
    expect(await eventsOf(match.id)).toEqual(['blood.crossmatch_recorded']);
    const reserved = await ok<Unit>(await move(unit, 'reserved', { patientId }, { user: nurse }));
    expect(reserved).toMatchObject({ status: 'reserved', patientId });
  });

  it('is for this unit and this patient, the latest result decides, and 72 hours is the limit', async () => {
    await wipe();
    await ok(await setGroup(patientId, 'O+'));
    const { unit } = await unitAt('available');
    await ok(await crossmatch(unit, patientId), 201);
    await ok(await crossmatch(unit, patientId, 'incompatible'), 201);
    expect(errorOf(await move(unit, 'reserved', { patientId }, { user: nurse }))).toEqual([
      409,
      'crossmatch_required',
    ]);
    // One that is older than 72 hours counts for nothing.
    await pool.query('delete from blood_crossmatches where blood_unit_id = $1', [unit.id]);
    await pool.query(
      `insert into blood_crossmatches (tenant_id, blood_unit_id, patient_id, result, performed_by, performed_at)
       values ($1, $2, $3, 'compatible', $4, now() - interval '73 hours')`,
      [hospital.id, unit.id, patientId, labTech.id],
    );
    expect(errorOf(await move(unit, 'reserved', { patientId }, { user: nurse }))).toEqual([
      409,
      'crossmatch_required',
    ]);
    await pool.query(
      `insert into blood_crossmatches (tenant_id, blood_unit_id, patient_id, result, performed_by, performed_at)
       values ($1, $2, $3, 'compatible', $4, now() - interval '71 hours')`,
      [hospital.id, unit.id, patientId, labTech.id],
    );
    expect((await move(unit, 'reserved', { patientId }, { user: nurse })).statusCode).toBe(200);
  });

  it('is enforced by the database: no reserve without one, none for another patient', async () => {
    await wipe();
    await ok(await setGroup(patientId, 'O+'));
    const { unit } = await unitAt('available');
    await expect(
      pool.query("update blood_units set status = 'reserved', patient_id = $2 where id = $1", [
        unit.id,
        patientId,
      ]),
    ).rejects.toThrow(/valid cross-match/);
    await pool.query(
      `insert into blood_crossmatches (tenant_id, blood_unit_id, patient_id, result, performed_by)
       values ($1, $2, $3, 'incompatible', $4)`,
      [hospital.id, unit.id, patientId, labTech.id],
    );
    await expect(
      pool.query("update blood_units set status = 'reserved', patient_id = $2 where id = $1", [
        unit.id,
        patientId,
      ]),
    ).rejects.toThrow(/valid cross-match/);
  });

  it('needs the patient’s group, a group that can match and an available unit', async () => {
    await wipe();
    const { unit } = await unitAt('available', 'A+');
    expect(errorOf(await crossmatch(unit, patientId))).toEqual([422, 'blood_group_unknown']);
    await ok(await setGroup(patientId, 'O+'));
    expect(errorOf(await crossmatch(unit, patientId))).toEqual([422, 'abo_incompatible']);
    // An honest "incompatible" is recorded; it only blocks.
    await ok(await crossmatch(unit, patientId, 'incompatible'), 201);
    expect(errorOf(await crossmatch(unit, clinicPatientId))).toEqual([422, 'unknown_patient']);
    const { unit: testing } = await unitAt('testing');
    expect(errorOf(await crossmatch(testing, patientId))).toEqual([409, 'not_available']);
    expect((await crossmatch(unit, patientId, 'compatible', { user: nurse })).statusCode).toBe(403);
  });

  it('lists the units that can be given, with the state of their cross-match', async () => {
    await wipe();
    await ok(await setGroup(patientId, 'A-'));
    const compatible = await unitAt('available', 'A-');
    const alsoGood = await unitAt('available', 'O-');
    await unitAt('available', 'A+');
    await unitAt('available', 'B-');
    await unitAt('available', 'O-', 'plasma');
    await ok(await crossmatch(compatible.unit, patientId), 201);
    const list = await ok<{
      patientBloodGroup: string;
      items: { unit: Unit; crossmatchValid: boolean }[];
    }>(
      await post('/blood/compatible-units', { patientId, component: 'red_cells' }, { user: nurse }),
    );
    expect(list.patientBloodGroup).toBe('A-');
    expect(list.items.map((item) => item.unit.id).sort()).toEqual(
      [compatible.unit.id, alsoGood.unit.id].sort(),
    );
    expect(list.items.find((item) => item.unit.id === compatible.unit.id)?.crossmatchValid).toBe(
      true,
    );
    expect(list.items.find((item) => item.unit.id === alsoGood.unit.id)?.crossmatchValid).toBe(
      false,
    );
    expect(await audited('patient_blood_group', patientId)).toContain('read');
    expect(
      errorOf(
        await post('/blood/compatible-units', {
          patientId: clinicPatientId,
          component: 'red_cells',
        }),
      ),
    ).toEqual([422, 'unknown_patient']);
    expect(
      (
        await post(
          '/blood/compatible-units',
          { patientId, component: 'red_cells' },
          { user: pharmacist },
        )
      ).statusCode,
    ).toBe(403);
    await wipe();
    await pool.query('delete from patient_blood_groups where tenant_id = $1', [hospital.id]);
    expect(
      errorOf(await post('/blood/compatible-units', { patientId, component: 'red_cells' })),
    ).toEqual([422, 'blood_group_unknown']);
  });
});

// --- row-level security ------------------------------------------------------------------------

describe('row-level security', () => {
  it('shows a hospital none of another’s donors, collections, screenings, groups or cross-matches', async () => {
    await wipe();
    await ok(await setGroup(patientId, 'O+'));
    const { unit } = await unitAt('available');
    await ok(await crossmatch(unit, patientId), 201);
    for (const table of [
      'blood_donors',
      'blood_collections',
      'blood_screenings',
      'patient_blood_groups',
      'blood_crossmatches',
    ]) {
      const own = await asTenantSql(pool, hospital.id, (client) =>
        client.query(`select 1 from ${table}`),
      );
      const other = await asTenantSql(pool, clinic.id, (client) =>
        client.query(`select 1 from ${table}`),
      );
      const none = await asTenantSql(pool, null, (client) =>
        client.query(`select 1 from ${table}`),
      );
      expect(own.rowCount, table).toBeGreaterThan(0);
      expect(other.rowCount, table).toBe(0);
      expect(none.rowCount, table).toBe(0);
    }
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into blood_donors (tenant_id, donor_number, full_name, date_of_birth, sex, blood_group, created_by)
           values ($1, 'X1', 'Other', '1990-01-01', 'male', 'O+', $2)`,
          [hospital.id, clinicAdmin.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into patient_blood_groups (tenant_id, patient_id, blood_group, recorded_by)
           values ($1, $2, 'O+', $3)`,
          [hospital.id, patientId, clinicAdmin.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
