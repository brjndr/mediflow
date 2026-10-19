import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryQueue } from '../../core/jobs/queue.js';
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
 * The triage API through the real app and database: recording and correcting readings, the
 * ranges by age, allergies replaced from a version, the hospital boundary, permissions, audit,
 * events and the encounter subscriber.
 */

let app: FastifyInstance;
let jobs: MemoryQueue;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** The triage module switched off. */
let closed: TestTenant;
let admin: TestUser;
let nurse: TestUser;
let doctor: TestUser;
let desk: TestUser;
let clinicNurse: TestUser;
const patients = { adult: '', child: '', other: '', clinic: '' };
let department = '';

interface Reading {
  id: string;
  tenantId: string;
  patientId: string;
  queueTokenId?: string;
  encounterId?: string;
  recordedAt: string;
  recordedById: string;
  recordedByName: string;
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  temperature?: number;
  spo2?: number;
  weight?: number;
  height?: number;
  chiefComplaint?: string;
  correctsId?: string;
  correctionReason?: string;
}
interface AllergyList {
  patientId: string;
  tenantId: string;
  status: string;
  items: { substance: string; reaction?: string; severity: string }[];
  version: number;
  updatedAt?: string;
  updatedByName?: string;
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

const get = (url: string, options: Options = {}) =>
  app.inject({ url, headers: as((options.tenant ?? hospital).id, (options.user ?? nurse).id) });
const record = (patientId: string, body: object, options: Options = {}) => {
  const { tenant = hospital, user = nurse, key = randomUUID() } = options;
  return app.inject({
    method: 'POST',
    url: `/patients/${patientId}/vitals`,
    headers: { ...as(tenant.id, user.id), ...(key === null ? {} : { 'idempotency-key': key }) },
    payload: body,
  });
};
const putAllergies = (patientId: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'PUT',
    url: `/patients/${patientId}/allergies`,
    headers: as((options.tenant ?? hospital).id, (options.user ?? nurse).id),
    payload: body,
  });
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

async function recorded(patientId: string, body: object, options: Options = {}): Promise<Reading> {
  const response = await record(patientId, body, options);
  if (response.statusCode !== 201) {
    throw new Error(`recording failed in test setup: ${response.statusCode} ${response.body}`);
  }
  return response.json<Reading>();
}

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string, dob: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Test', $4, 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `TR-${String(mrn).padStart(7, '0')}`, first, dob],
  );
  return rows[0]?.id ?? '';
}

/** A token of today at the hospital, or of another day. */
async function addToken(patientId: string, daysAgo = 0) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into queue_tokens (tenant_id, day, department_id, number, patient_id, issued_by)
     select $1, (now() at time zone timezone)::date - $4::int, $2,
            coalesce((select max(number) from queue_tokens where tenant_id = $1), 0) + 1, $3, $5
     from tenants where id = $1
     returning id`,
    [hospital.id, department, patientId, daysAgo, nurse.id],
  );
  return rows[0]?.id ?? '';
}

const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      `select action from audit_log
       where tenant_id = $1 and entity = $2 and entity_id = $3 order by at`,
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

const events = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at',
      [hospital.id, entityId],
    )
  ).rows;

const clearTriage = async () => {
  const tenants = [hospital.id, clinic.id, closed.id];
  await pool.query('delete from vitals where tenant_id = any($1)', [tenants]);
  await pool.query('delete from allergy_lists where tenant_id = any($1)', [tenants]);
  await pool.query('delete from vital_ranges where tenant_id = any($1)', [tenants]);
  await pool.query('delete from queue_tokens where tenant_id = any($1)', [tenants]);
  await pool.query('delete from outbox where tenant_id = any($1)', [tenants]);
};

beforeAll(async () => {
  jobs = new MemoryQueue();
  app = await buildTestApp({ resolveSession: resolveTestSession, jobQueue: jobs });
  pool = app.database.pool;
  const features = { triage: true, queue: true, patients: true };
  hospital = await createTenant(pool, 'Triage Hospital', { features });
  clinic = await createTenant(pool, 'Triage Clinic', { features, timezone: 'Asia/Dubai' });
  closed = await createTenant(pool, 'Triage Closed', { features: { ...features, triage: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Triage Admin');
  nurse = await user('Triage Nurse');
  doctor = await user('Triage Doctor');
  desk = await user('Triage Desk');
  clinicNurse = await user('Triage Clinic Nurse');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, nurse, closed, 'nurse');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, clinicNurse, clinic, 'nurse');
  const { rows } = await pool.query<{ id: string }>(
    "insert into departments (tenant_id, name) values ($1, 'General') returning id",
    [hospital.id],
  );
  department = rows[0]?.id ?? '';
  patients.adult = await addPatient(hospital, 'Asha', '1980-05-01');
  // Seventeen today at the hospital: one day short of eighteen.
  const { rows: childDob } = await pool.query<{ dob: string }>(
    "select ((now() at time zone 'Asia/Kolkata')::date - interval '18 years' + interval '1 day')::date::text as dob",
  );
  patients.child = await addPatient(hospital, 'Bala', childDob[0]?.dob ?? '');
  patients.other = await addPatient(hospital, 'Chitra', '1990-01-01');
  patients.clinic = await addPatient(clinic, 'Dina', '1985-01-01');
});

afterEach(clearTriage);

afterAll(async () => {
  await clearTriage();
  const tenants = [hospital.id, clinic.id, closed.id];
  await pool.query('delete from patients where tenant_id = any($1)', [tenants]);
  await pool.query('delete from departments where tenant_id = any($1)', [tenants]);
  await deleteUsers(pool, [admin, nurse, doctor, desk, clinicNurse]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('recording a reading', () => {
  it('records the measurements, the complaint and the token, and says who took them', async () => {
    const token = await addToken(patients.adult);
    const reading = await recorded(patients.adult, {
      queueTokenId: token,
      systolic: 150,
      diastolic: 95,
      pulse: 104,
      temperature: 37.5,
      spo2: 97,
      weight: 61.4,
      height: 158,
      chiefComplaint: '  Headache   for two days\n\n\n\nand dizziness ',
    });
    expect(reading).toMatchObject({
      tenantId: hospital.id,
      patientId: patients.adult,
      queueTokenId: token,
      recordedById: nurse.id,
      recordedByName: 'Triage Nurse',
      systolic: 150,
      temperature: 37.5,
      weight: 61.4,
      chiefComplaint: 'Headache for two days\n\nand dizziness',
    });
    expect(reading.encounterId).toBeUndefined();
    expect(await audited('vitals', reading.id)).toEqual(['create']);
    expect(await events(reading.id)).toEqual([
      {
        event: 'vitals.recorded',
        payload: { vitalsId: reading.id, patientId: patients.adult, queueTokenId: token },
      },
    ]);
  });

  it('refuses what a body cannot be, and an empty reading', async () => {
    for (const body of [
      {},
      { systolic: 120 },
      { systolic: 80, diastolic: 90 },
      { pulse: 10 },
      { temperature: 37.55 },
      { weight: 0.2 },
      { spo2: 98.5 },
      { chiefComplaint: '   ' },
      { pulse: 80, correctionReason: 'typo' },
    ]) {
      expect(errorOf(await record(patients.adult, body))).toEqual([400, 'validation_failed']);
    }
  });

  it('takes a token of this patient today only', async () => {
    const yesterday = await addToken(patients.adult, 1);
    const someoneElse = await addToken(patients.other);
    for (const queueTokenId of [yesterday, someoneElse, randomUUID()]) {
      expect(errorOf(await record(patients.adult, { pulse: 80, queueTokenId }))).toEqual([
        422,
        'token_not_for_patient',
      ]);
    }
    const today = await addToken(patients.adult);
    // A second reading for the same token is a re-check, not a refusal.
    await recorded(patients.adult, { pulse: 80, queueTokenId: today });
    await recorded(patients.adult, { pulse: 84, queueTokenId: today });
    const page = (await get(`/patients/${patients.adult}/vitals?queueTokenId=${today}`)).json<
      Page<Reading>
    >();
    expect(page.items.map((reading) => reading.pulse)).toEqual([84, 80]);
  });

  it('corrects a reading once, carrying its token, and keeps the original', async () => {
    const token = await addToken(patients.adult);
    const original = await recorded(patients.adult, { pulse: 180, queueTokenId: token });
    const body = { pulse: 80, correctsId: original.id, correctionReason: 'Typed 180 for 80' };
    const correction = await recorded(patients.adult, body);
    expect(correction).toMatchObject({ correctsId: original.id, queueTokenId: token, pulse: 80 });
    expect(errorOf(await record(patients.adult, body))).toEqual([422, 'already_corrected']);
    // A later correction corrects the correction.
    await recorded(patients.adult, { ...body, correctsId: correction.id });
    expect(
      errorOf(
        await record(patients.adult, { ...body, queueTokenId: token, correctsId: correction.id }),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(errorOf(await record(patients.other, { ...body, correctsId: original.id }))).toEqual([
      422,
      'unknown_correction',
    ]);
    const all = (await get(`/patients/${patients.adult}/vitals`)).json<Page<Reading>>();
    expect(all.total).toBe(3);
    expect(all.items.at(-1)?.id).toBe(original.id);
  });

  it('records one correction of two sent at the same moment', async () => {
    const original = await recorded(patients.adult, { pulse: 180 });
    const body = { pulse: 80, correctsId: original.id, correctionReason: 'Typo' };
    const both = await Promise.all([record(patients.adult, body), record(patients.adult, body)]);
    expect(both.map((response) => response.statusCode).sort()).toEqual([201, 422]);
  });

  it('answers a repeat with the same reading, recording nothing again', async () => {
    const key = randomUUID();
    const first = await record(patients.adult, { pulse: 70 }, { key });
    const again = await record(patients.adult, { pulse: 70 }, { key });
    expect(again.statusCode).toBe(201);
    expect(again.json<Reading>().id).toBe(first.json<Reading>().id);
    expect((await get(`/patients/${patients.adult}/vitals`)).json<Page<Reading>>().total).toBe(1);
    expect(errorOf(await record(patients.adult, { pulse: 70 }, { key: null }))).toEqual([
      400,
      'validation_failed',
    ]);
  });

  it('pages a patient’s readings newest first, and refuses a cursor it did not make', async () => {
    for (const pulse of [61, 62, 63]) await recorded(patients.adult, { pulse });
    const first = (await get(`/patients/${patients.adult}/vitals?limit=2`)).json<Page<Reading>>();
    expect(first.items.map((reading) => reading.pulse)).toEqual([63, 62]);
    const rest = (
      await get(`/patients/${patients.adult}/vitals?limit=2&cursor=${first.nextCursor ?? ''}`)
    ).json<Page<Reading>>();
    expect(rest.items.map((reading) => reading.pulse)).toEqual([61]);
    expect(errorOf(await get(`/patients/${patients.adult}/vitals?cursor=nope`))).toEqual([
      400,
      'invalid_cursor',
    ]);
    const one = await get(`/patients/${patients.adult}/vitals/${rest.items[0]?.id ?? ''}`);
    expect(one.json<Reading>().pulse).toBe(61);
    expect(
      errorOf(await get(`/patients/${patients.other}/vitals/${rest.items[0]?.id ?? ''}`)),
    ).toEqual([404, 'not_found']);
  });

  it('attaches a token’s readings to the encounter it opens, once', async () => {
    const token = await addToken(patients.adult);
    const reading = await recorded(patients.adult, { pulse: 72, queueTokenId: token });
    const elsewhere = await recorded(patients.adult, { pulse: 75 });
    const encounterId = randomUUID();
    const publish = async (id: string) => {
      await pool.query(
        `insert into outbox (tenant_id, event, entity_id, actor_id, payload)
         values ($1, 'encounter.opened', $2, null, $3)`,
        [hospital.id, id, JSON.stringify({ queueTokenId: token })],
      );
      await app.events.dispatch();
      await jobs.drain();
    };
    await publish(encounterId);
    await publish(randomUUID());
    const now = (await get(`/patients/${patients.adult}/vitals/${reading.id}`)).json<Reading>();
    expect(now.encounterId).toBe(encounterId);
    const other = (await get(`/patients/${patients.adult}/vitals/${elsewhere.id}`)).json<Reading>();
    expect(other.encounterId).toBeUndefined();
  });
});

describe('ranges', () => {
  it('gives the built-in adult ranges while the hospital has none, and null under 18', async () => {
    const adult = await get(`/patients/${patients.adult}/vital-ranges`);
    expect(adult.json()).toEqual({
      ranges: {
        systolic: { low: 90, high: 139 },
        diastolic: { low: 60, high: 89 },
        pulse: { low: 60, high: 100 },
        temperature: { low: 36.1, high: 37.8 },
        spo2: { low: 95 },
      },
    });
    expect((await get(`/patients/${patients.child}/vital-ranges`)).json()).toEqual({
      ranges: null,
    });
    expect(await audited('vital_ranges', patients.child)).toEqual(['read']);
    expect(errorOf(await get(`/patients/${patients.clinic}/vital-ranges`))).toEqual([
      404,
      'not_found',
    ]);
  });

  it('gives the hospital’s own ranges once it has them', async () => {
    await pool.query(
      `insert into vital_ranges (tenant_id, measure, low, high)
       values ($1, 'temperature', 36.1, 37.5), ($1, 'spo2', 94, null)`,
      [hospital.id],
    );
    expect((await get(`/patients/${patients.adult}/vital-ranges`)).json()).toEqual({
      ranges: { spo2: { low: 94 }, temperature: { low: 36.1, high: 37.5 } },
    });
  });
});

describe('allergies', () => {
  it('says never asked until recorded, then replaces the list from its version', async () => {
    const never = (await get(`/patients/${patients.adult}/allergies`)).json<AllergyList>();
    expect(never).toEqual({
      patientId: patients.adult,
      tenantId: hospital.id,
      status: 'unknown',
      items: [],
      version: 0,
    });
    const none = await putAllergies(patients.adult, { version: 0, status: 'none', items: [] });
    expect(none.json<AllergyList>()).toMatchObject({
      status: 'none',
      version: 1,
      updatedByName: 'Triage Nurse',
    });
    const listed = await putAllergies(patients.adult, {
      version: 1,
      status: 'listed',
      items: [{ substance: '  Penicillin ', reaction: 'Rash', severity: 'severe' }],
    });
    expect(listed.json<AllergyList>()).toMatchObject({
      status: 'listed',
      version: 2,
      items: [{ substance: 'Penicillin', reaction: 'Rash', severity: 'severe' }],
    });
    expect(await audited('allergy_list', patients.adult)).toEqual(['read', 'update', 'update']);
    expect(await events(patients.adult)).toEqual([
      { event: 'allergy.updated', payload: { patientId: patients.adult, version: 1 } },
      { event: 'allergy.updated', payload: { patientId: patients.adult, version: 2 } },
    ]);
  });

  it('refuses a change from an old version, even two at the same moment', async () => {
    const body = { version: 0, status: 'none', items: [] };
    const both = await Promise.all([
      putAllergies(patients.adult, body),
      putAllergies(patients.adult, body),
    ]);
    expect(both.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(errorOf(await putAllergies(patients.adult, { ...body, version: 5 }))).toEqual([
      409,
      'conflict',
    ]);
  });

  it('refuses a list that does not match its status', async () => {
    for (const body of [
      { version: 0, status: 'none', items: [{ substance: 'Dust', severity: 'mild' }] },
      { version: 0, status: 'listed', items: [] },
      { version: 0, status: 'unknown', items: [] },
      { version: 0, status: 'listed', items: [{ substance: 'Dust', severity: 'awful' }] },
    ]) {
      expect(errorOf(await putAllergies(patients.adult, body))).toEqual([400, 'validation_failed']);
    }
  });
});

describe('access', () => {
  it('lets the doctor read but not record, and the desk do neither', async () => {
    expect((await get(`/patients/${patients.adult}/vitals`, { user: doctor })).statusCode).toBe(
      200,
    );
    expect((await get(`/patients/${patients.adult}/allergies`, { user: doctor })).statusCode).toBe(
      200,
    );
    expect(errorOf(await record(patients.adult, { pulse: 70 }, { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      errorOf(
        await putAllergies(
          patients.adult,
          { version: 0, status: 'none', items: [] },
          { user: doctor },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
    expect(errorOf(await get(`/patients/${patients.adult}/vitals`, { user: desk }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('refuses a hospital with the module off', async () => {
    expect(errorOf(await get(`/patients/${patients.adult}/vitals`, { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('the hospital boundary', () => {
  it('answers 404 for another hospital’s patient and shows no reading across hospitals', async () => {
    const ours = await recorded(patients.adult, { pulse: 70 });
    await putAllergies(patients.adult, { version: 0, status: 'none', items: [] });
    const clinicOptions = { tenant: clinic, user: clinicNurse };
    expect(errorOf(await get(`/patients/${patients.adult}/vitals`, clinicOptions))).toEqual([
      404,
      'not_found',
    ]);
    expect(errorOf(await get(`/patients/${patients.adult}/allergies`, clinicOptions))).toEqual([
      404,
      'not_found',
    ]);
    expect(errorOf(await record(patients.adult, { pulse: 70 }, clinicOptions))).toEqual([
      404,
      'not_found',
    ]);
    expect(
      errorOf(
        await putAllergies(
          patients.adult,
          { version: 1, status: 'none', items: [] },
          clinicOptions,
        ),
      ),
    ).toEqual([404, 'not_found']);
    await asTenantSql(pool, clinic.id, async (client) => {
      expect((await client.query('select id from vitals')).rows).toEqual([]);
      expect((await client.query('select 1 from allergy_lists')).rows).toEqual([]);
      const changed = await client.query(
        "update allergy_lists set status = 'none' where patient_id = $1",
        [patients.adult],
      );
      expect(changed.rowCount).toBe(0);
    });
    for (const [tenantId, patientId] of [
      [hospital.id, patients.adult],
      [clinic.id, patients.adult],
    ]) {
      await expect(
        asTenantSql(pool, clinic.id, (client) =>
          client.query(
            'insert into vitals (tenant_id, patient_id, recorded_by, pulse) values ($1, $2, $3, 70)',
            [tenantId, patientId, clinicNurse.id],
          ),
        ),
      ).rejects.toThrow();
    }
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query('insert into vital_ranges (tenant_id, measure, low) values ($1, $2, 1)', [
          clinic.id,
          'pulse',
        ]),
      ),
    ).rejects.toThrow();
    // A reading never changes and is never removed, by the app or anyone else.
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('update vitals set pulse = 71 where id = $1', [ours.id]),
      ).rejects.toThrow();
    });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query('delete from vitals')).rejects.toThrow();
    });
    await expect(
      pool.query('update vitals set pulse = 71 where id = $1', [ours.id]),
    ).rejects.toThrow(/never changed/);
  });
});
