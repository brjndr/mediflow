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
import { bandOf, dateAt } from './repository.js';

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
const patients = { adult: '', child: '', infant: '', other: '', clinic: '' };
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
  flags?: Record<string, string>;
}
interface RangeTable {
  version: number;
  bands: Record<
    'infant' | 'child' | 'adolescent' | 'adult',
    Record<string, { low?: number; high?: number }>
  >;
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
const rangeTable = async (options: Options = {}) =>
  (await get('/vitals/ranges', { user: admin, ...options })).json<RangeTable>();
const putRanges = (body: object, options: Options = {}) =>
  app.inject({
    method: 'PUT',
    url: '/vitals/ranges',
    headers: as((options.tenant ?? hospital).id, (options.user ?? admin).id),
    payload: body,
  });
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

/** An encounter of the patient, as the clinical module opens one. */
async function addEncounter(patientId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into encounters (tenant_id, patient_id, type, opened_by)
     values ($1, $2, 'opd', $3) returning id`,
    [hospital.id, patientId, doctor.id],
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
  await pool.query('delete from encounters where tenant_id = any($1)', [tenants]);
  await pool.query('delete from allergy_list_versions where tenant_id = any($1)', [tenants]);
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
  await addMembership(pool, admin, clinic, 'admin');
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
  const { rows: infantDob } = await pool.query<{ dob: string }>(
    "select ((now() at time zone 'Asia/Kolkata')::date - interval '6 months')::date::text as dob",
  );
  patients.infant = await addPatient(hospital, 'Esha', infantDob[0]?.dob ?? '');
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
    const encounterId = await addEncounter(patients.adult);
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
    await publish(await addEncounter(patients.adult));
    const now = (await get(`/patients/${patients.adult}/vitals/${reading.id}`)).json<Reading>();
    expect(now.encounterId).toBe(encounterId);
    const other = (await get(`/patients/${patients.adult}/vitals/${elsewhere.id}`)).json<Reading>();
    expect(other.encounterId).toBeUndefined();
  });
});

describe('age bands', () => {
  it('chooses the band from the age in whole years on the day', () => {
    expect(bandOf('2025-06-15', '2026-06-14')).toBe('infant');
    expect(bandOf('2025-06-15', '2026-06-15')).toBe('child');
    expect(bandOf('2015-06-15', '2026-06-14')).toBe('child');
    expect(bandOf('2014-06-15', '2026-06-15')).toBe('adolescent');
    expect(bandOf('2008-06-15', '2026-06-14')).toBe('adolescent');
    expect(bandOf('2008-06-15', '2026-06-15')).toBe('adult');
    // 29 February: a person born that day is a year older on 1 March in a common year.
    expect(bandOf('2008-02-29', '2026-02-28')).toBe('adolescent');
    expect(bandOf('2008-02-29', '2026-03-01')).toBe('adult');
  });

  it('reads the day on the hospital’s clock, not on UTC', () => {
    // 20:00 UTC on 14 June is already 15 June in Kolkata and in Dubai.
    const moment = new Date('2026-06-14T20:00:00Z');
    expect(dateAt(moment, 'Asia/Kolkata')).toBe('2026-06-15');
    expect(dateAt(moment, 'UTC')).toBe('2026-06-14');
  });
});

describe('ranges', () => {
  it('gives the built-in ranges of the patient’s band while the hospital has none', async () => {
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
    // Seventeen, one day short of eighteen: ranges for children are no longer withheld (#379).
    const adolescent = (await get(`/patients/${patients.child}/vital-ranges`)).json<{
      ranges: Record<string, unknown>;
    }>();
    expect(adolescent.ranges.pulse).toEqual({ low: 60, high: 105 });
    const infant = (await get(`/patients/${patients.infant}/vital-ranges`)).json<{
      ranges: Record<string, unknown>;
    }>();
    expect(infant.ranges.pulse).toEqual({ low: 100, high: 160 });
    expect(await audited('vital_ranges', patients.child)).toEqual(['read']);
    expect(errorOf(await get(`/patients/${patients.clinic}/vital-ranges`))).toEqual([
      404,
      'not_found',
    ]);
  });

  it('shows the whole table at version 0 and saves it as a new version', async () => {
    const before = await rangeTable();
    expect(before.version).toBe(0);
    expect(Object.keys(before.bands)).toEqual(['infant', 'child', 'adolescent', 'adult']);
    expect(before.bands.adult.temperature).toEqual({ low: 36.1, high: 37.8 });

    const edited = {
      version: 0,
      bands: {
        ...before.bands,
        adult: { ...before.bands.adult, temperature: { low: 36.1, high: 37.5 }, spo2: {} },
        child: { ...before.bands.child, pulse: { high: 125.5 } },
      },
    };
    const saved = await putRanges(edited);
    expect(saved.statusCode).toBe(200);
    const after = saved.json<RangeTable>();
    expect(after.version).toBe(1);
    expect(after.bands.adult.temperature).toEqual({ low: 36.1, high: 37.5 });
    // A measure with no limit is not checked, and does not fall back to the built-in one.
    expect(after.bands.adult.spo2).toBeUndefined();
    expect(after.bands.child.pulse).toEqual({ high: 125.5 });
    expect(after.bands.infant).toEqual(before.bands.infant);
    expect((await rangeTable()).bands).toEqual(after.bands);

    expect((await get(`/patients/${patients.adult}/vital-ranges`)).json()).toEqual({
      ranges: {
        systolic: { low: 90, high: 139 },
        diastolic: { low: 60, high: 89 },
        pulse: { low: 60, high: 100 },
        temperature: { low: 36.1, high: 37.5 },
      },
    });
    const { rows } = await pool.query<{ action: string }>(
      "select action from audit_log where tenant_id = $1 and entity = 'vital_ranges' order by at",
      [hospital.id],
    );
    expect(rows.map((row) => row.action)).toContain('update');
  });

  it('refuses a stale version, a low limit not below its high, and a third decimal', async () => {
    const { bands } = await rangeTable();
    expect((await putRanges({ version: 0, bands })).statusCode).toBe(200);
    // The same version again: someone saved first.
    expect(errorOf(await putRanges({ version: 0, bands }))).toEqual([409, 'conflict']);
    expect((await rangeTable()).version).toBe(1);

    const withPulse = (pulse: object) => ({
      version: 1,
      bands: { ...bands, adult: { ...bands.adult, pulse } },
    });
    expect(errorOf(await putRanges(withPulse({ low: 100, high: 60 })))).toEqual([
      422,
      'invalid_range',
    ]);
    expect(errorOf(await putRanges(withPulse({ low: 80, high: 80 })))).toEqual([
      422,
      'invalid_range',
    ]);
    expect(errorOf(await putRanges(withPulse({ low: 60.25 })))).toEqual([422, 'invalid_range']);
    expect(errorOf(await putRanges(withPulse({ low: -1 })))).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await putRanges({ version: 1, bands: { ...bands, infant: undefined } })),
    ).toEqual([400, 'validation_failed']);
    expect((await rangeTable()).version).toBe(1);
  });

  it('marks a reading against the ranges in effect when it was recorded', async () => {
    const early = await recorded(patients.adult, { pulse: 110, temperature: 37 });
    expect(early.flags).toEqual({ pulse: 'high' });

    const { bands } = await rangeTable();
    const looser = { ...bands.adult, pulse: { low: 60, high: 120 } };
    expect((await putRanges({ version: 0, bands: { ...bands, adult: looser } })).statusCode).toBe(
      200,
    );

    const late = await recorded(patients.adult, { pulse: 110 });
    expect(late.flags).toEqual({});
    // The earlier reading keeps its mark, in a list and on its own.
    const page = (await get(`/patients/${patients.adult}/vitals`)).json<Page<Reading>>();
    expect(page.items.map((item) => [item.id === early.id, item.flags])).toEqual([
      [false, {}],
      [true, { pulse: 'high' }],
    ]);
    expect(
      (await get(`/patients/${patients.adult}/vitals/${early.id}`)).json<Reading>().flags,
    ).toEqual({ pulse: 'high' });
  });

  it('marks a reading against the band the patient was in that day', async () => {
    const infant = await recorded(patients.infant, { pulse: 90, spo2: 97, temperature: 38.5 });
    expect(infant.flags).toEqual({ pulse: 'low', temperature: 'high' });
    const adolescent = await recorded(patients.child, { pulse: 90, systolic: 140, diastolic: 80 });
    expect(adolescent.flags).toEqual({ systolic: 'high' });
  });

  it('keeps each hospital’s ranges apart', async () => {
    const { bands } = await rangeTable();
    const strict = { ...bands.adult, pulse: { low: 70, high: 80 } };
    expect((await putRanges({ version: 0, bands: { ...bands, adult: strict } })).statusCode).toBe(
      200,
    );
    const clinicAdmin = { tenant: clinic, user: admin };
    const theirs = await rangeTable(clinicAdmin);
    expect(theirs.version).toBe(0);
    expect(theirs.bands.adult.pulse).toEqual({ low: 60, high: 100 });
    expect(
      (await recorded(patients.clinic, { pulse: 75 }, { tenant: clinic, user: clinicNurse })).flags,
    ).toEqual({});
    const counted = await pool.query(
      'select count(*)::int as n from vital_ranges where tenant_id = $1',
      [clinic.id],
    );
    expect(counted.rows[0]).toEqual({ n: 0 });
    // The clinic's own save does not reach the hospital either.
    expect((await putRanges({ version: 0, bands: theirs.bands }, clinicAdmin)).statusCode).toBe(
      200,
    );
    expect((await rangeTable()).bands.adult.pulse).toEqual({ low: 70, high: 80 });
  });

  it('is for those who may configure, and only where the module is on', async () => {
    const { bands } = await rangeTable();
    for (const user of [nurse, doctor, desk]) {
      expect(errorOf(await putRanges({ version: 0, bands }, { user }))).toEqual([
        403,
        'permission_denied',
      ]);
    }
    expect((await rangeTable()).version).toBe(0);
    // Reading the table needs only vitals:read.
    expect((await get('/vitals/ranges', { user: nurse })).statusCode).toBe(200);
    expect((await get('/vitals/ranges', { user: doctor })).statusCode).toBe(200);
    expect(errorOf(await get('/vitals/ranges', { user: desk }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await get('/vitals/ranges', { tenant: closed, user: nurse }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(
      errorOf(await putRanges({ version: 0, bands }, { tenant: closed, user: nurse })),
    ).toEqual([403, 'feature_disabled']);
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

describe('coded allergens (#380)', () => {
  interface Allergen {
    name: string;
    kind: string;
    allergenId?: string;
    drugId?: string;
  }
  const search = (body: object, options: Options = {}) =>
    app.inject({
      method: 'POST',
      url: '/allergens/search',
      headers: as((options.tenant ?? hospital).id, (options.user ?? nurse).id),
      payload: body,
    });
  const names = async (body: object, options: Options = {}) =>
    (await search(body, options)).json<Page<Allergen>>().items.map((item) => item.name);

  const addDrug = async (tenant: TestTenant, generic: string, brand: string, archived = false) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into drugs (tenant_id, type, generic_name, brand_name, form, schedule, tax_class, archived)
       values ($1, 'medicine', $2, $3, 'tablet', 'none', 'exempt', $4) returning id`,
      [tenant.id, generic, brand, archived],
    );
    return rows[0]?.id ?? '';
  };
  afterEach(async () => {
    await pool.query('delete from drugs where tenant_id = any($1)', [[hospital.id, clinic.id]]);
  });

  it('finds catalog entries and the hospital’s own medicines, each once, by name', async () => {
    await addDrug(hospital, 'Amoxicillin', 'Novamox');
    await addDrug(hospital, 'Amoxicillin', 'Mox');
    await addDrug(hospital, 'Cetirizine', 'Cetzine', true);
    await addDrug(clinic, 'Amoxapine', 'Clinic only');
    const found = (await search({ q: 'amox' })).json<Page<Allergen>>();
    expect(found.items).toEqual([
      { name: 'Amoxicillin', kind: 'drug', drugId: expect.any(String) },
    ]);
    expect(found.total).toBeUndefined();
    expect(await names({ q: 'penic' })).toEqual(['Penicillins']);
    expect(await names({ q: 'amox' }, { tenant: clinic, user: clinicNurse })).toEqual([
      'Amoxapine',
    ]);
    expect(await names({ q: 'cetirizine' })).toEqual([]);
    expect(await names({ q: 'nuts', kind: 'food' })).toEqual(['Peanuts', 'Tree nuts']);
    expect(await names({ q: 'nuts', kind: 'drug' })).toEqual([]);
  });

  it('pages through the two sources in name order', async () => {
    await addDrug(hospital, 'Aspirin', 'Disprin');
    await addDrug(hospital, 'Zolpidem', 'Zolfresh');
    const all = await names({ limit: 100 });
    expect(all).toEqual(
      [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en')),
    );
    const paged: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = (await search({ limit: 4, ...(cursor ? { cursor } : {}) })).json<
        Page<Allergen>
      >();
      paged.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(paged.length);
    expect(errorOf(await search({ cursor: 'nonsense' }))).toEqual([400, 'invalid_cursor']);
  });

  it('pages past names that sort differently by collation, once each', async () => {
    // Space, hyphen and none: the order a locale gives them is not the bytes' order.
    for (const generic of ['Co trimoxazole', 'Co-trimoxazole', 'Cotrimoxazole', 'Co_trimoxazole']) {
      await addDrug(hospital, generic, 'B');
    }
    const paged: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = (
        await search({ q: 'trimoxazole', limit: 1, ...(cursor ? { cursor } : {}) })
      ).json<Page<Allergen>>();
      paged.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect([...paged].sort()).toEqual(
      ['Co trimoxazole', 'Co-trimoxazole', 'Co_trimoxazole', 'Cotrimoxazole'].sort(),
    );
    expect(paged).toEqual([...paged].sort());
  });

  it('stores a drug’s name for matching as the web reads names, punctuation turned to spaces', async () => {
    const drugId = await addDrug(hospital, 'Paracetamol (Acetaminophen) 0.9%', 'P');
    const saved = await putAllergies(patients.adult, {
      version: 0,
      status: 'listed',
      items: [{ substance: 'x', drugId, severity: 'mild' }],
    });
    expect(saved.json<AllergyList>().items[0]).toMatchObject({
      substance: 'Paracetamol (Acetaminophen) 0.9%',
      members: ['paracetamol acetaminophen 0 9'],
    });
  });

  it('is for those who read allergies, with the module on', async () => {
    expect((await search({}, { user: desk })).statusCode).toBe(403);
    expect((await search({}, { tenant: closed })).statusCode).toBe(403);
  });

  it('stores an allergy that names a class with what it covers, and keeps free text', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `select id from allergens where name = 'Penicillins'`,
    );
    const allergenId = rows[0]?.id ?? '';
    const drugId = await addDrug(hospital, 'Cetirizine', 'Cetzine');
    const saved = await putAllergies(patients.adult, {
      version: 0,
      status: 'listed',
      items: [
        { substance: 'x', allergenId, severity: 'severe' },
        { substance: 'x', drugId, severity: 'mild' },
        { substance: 'Mango', severity: 'unknown' },
      ],
    });
    const list = saved.json<AllergyList>();
    expect(list.items[0]).toMatchObject({
      substance: 'Penicillins',
      kind: 'drug_class',
      allergenId,
      members: expect.arrayContaining(['amoxicillin']),
    });
    expect(list.items[1]).toEqual({
      substance: 'Cetirizine',
      kind: 'drug',
      drugId,
      members: ['cetirizine'],
      severity: 'mild',
    });
    expect(list.items[2]).toEqual({ substance: 'Mango', severity: 'unknown' });
    // The medicine is archived afterwards: what was recorded does not change.
    await pool.query('update drugs set archived = true where id = $1', [drugId]);
    const again = (await get(`/patients/${patients.adult}/allergies`)).json<AllergyList>();
    expect(again.items).toEqual(list.items);
    // Saving the list again with the same medicine still works, and keeps it as recorded.
    const resaved = await putAllergies(patients.adult, {
      version: again.version,
      status: 'listed',
      items: [
        { substance: 'x', allergenId, severity: 'severe' },
        { substance: 'x', drugId, severity: 'moderate' },
      ],
    });
    expect(resaved.statusCode).toBe(200);
    expect(resaved.json<AllergyList>().items[1]).toMatchObject({
      substance: 'Cetirizine',
      kind: 'drug',
      severity: 'moderate',
    });
  });

  it('refuses an allergen that does not exist at the hospital, or two at once', async () => {
    const other = await addDrug(clinic, 'Clinicillin', 'C');
    for (const item of [
      { substance: 'x', allergenId: randomUUID(), severity: 'mild' },
      { substance: 'x', allergenId: 'not-an-id', severity: 'mild' },
      { substance: 'x', drugId: other, severity: 'mild' },
      { substance: 'x', drugId: randomUUID(), severity: 'mild' },
    ]) {
      expect(
        errorOf(
          await putAllergies(patients.adult, { version: 0, status: 'listed', items: [item] }),
        ),
      ).toEqual([422, 'unknown_allergen']);
    }
    const { rows } = await pool.query<{ id: string }>(`select id from allergens limit 1`);
    const both = {
      substance: 'x',
      allergenId: rows[0]?.id,
      drugId: randomUUID(),
      severity: 'mild',
    };
    expect(
      errorOf(await putAllergies(patients.adult, { version: 0, status: 'listed', items: [both] })),
    ).toEqual([400, 'validation_failed']);
  });

  it('cannot change the catalog under the app role', async () => {
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query(`update allergens set name = 'x'`)).rejects.toMatchObject({
        code: '42501',
      });
    });
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
    // Ranges can be added, but only for one's own hospital, and never changed or removed.
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          "insert into vital_ranges (tenant_id, band, measure, low, effective_from) values ($1, 'adult', 'pulse', 1, now())",
          [hospital.id],
        ),
      ),
    ).rejects.toThrow();
    await asTenantSql(pool, clinic.id, async (client) => {
      await client.query(
        "insert into vital_ranges (tenant_id, band, measure, low, effective_from) values ($1, 'adult', 'pulse', 1, now())",
        [clinic.id],
      );
      await expect(client.query('update vital_ranges set low = 2')).rejects.toThrow();
    });
    await asTenantSql(pool, clinic.id, async (client) => {
      await client.query(
        "insert into vital_ranges (tenant_id, band, measure, low, effective_from) values ($1, 'adult', 'pulse', 1, now())",
        [clinic.id],
      );
      await expect(client.query('delete from vital_ranges')).rejects.toThrow();
    });
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

describe('more of the triage rules', () => {
  /** Narrows a permission of the nurse's role at the hospital for the length of `run`. */
  async function nurseOwn<T>(permission: string, run: () => Promise<T>) {
    await pool.query(
      "update role_permissions set scope = 'own' where tenant_id = $1 and role_id = 'nurse' and permission = $2",
      [hospital.id, permission],
    );
    try {
      return await run();
    } finally {
      await pool.query(
        "update role_permissions set scope = 'all' where tenant_id = $1 and role_id = 'nurse' and permission = $2",
        [hospital.id, permission],
      );
    }
  }

  it('applies the scope of each permission as the patients module does', async () => {
    // The sample patients were registered by 'test', so `own` reaches none of them.
    const reading = await recorded(patients.adult, { pulse: 70 });
    await nurseOwn('vitals:read', async () => {
      expect(errorOf(await get(`/patients/${patients.adult}/vitals`))).toEqual([404, 'not_found']);
      expect(errorOf(await get(`/patients/${patients.adult}/vitals/${reading.id}`))).toEqual([
        404,
        'not_found',
      ]);
      expect(errorOf(await get(`/patients/${patients.adult}/vital-ranges`))).toEqual([
        404,
        'not_found',
      ]);
    });
    await nurseOwn('vitals:record', async () => {
      expect(errorOf(await record(patients.adult, { pulse: 70 }))).toEqual([404, 'not_found']);
    });
    await nurseOwn('allergy:read', async () => {
      expect(errorOf(await get(`/patients/${patients.adult}/allergies`))).toEqual([
        404,
        'not_found',
      ]);
    });
    await nurseOwn('allergy:update', async () => {
      expect(
        errorOf(await putAllergies(patients.adult, { version: 0, status: 'none', items: [] })),
      ).toEqual([404, 'not_found']);
    });
  });

  it('keeps every version of an allergy list, which the app can neither change nor remove', async () => {
    await putAllergies(patients.adult, {
      version: 0,
      status: 'listed',
      items: [{ substance: 'Penicillin', severity: 'severe' }],
    });
    await putAllergies(patients.adult, { version: 1, status: 'none', items: [] });
    const { rows } = await pool.query<{ version: number; status: string; items: unknown }>(
      'select version, status, items from allergy_list_versions where patient_id = $1 order by version',
      [patients.adult],
    );
    expect(rows).toEqual([
      { version: 1, status: 'listed', items: [{ substance: 'Penicillin', severity: 'severe' }] },
      { version: 2, status: 'none', items: [] },
    ]);
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query("update allergy_list_versions set status = 'none'"),
      ).rejects.toThrow();
    });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query('delete from allergy_list_versions')).rejects.toThrow();
    });
    await asTenantSql(pool, clinic.id, async (client) => {
      expect((await client.query('select 1 from allergy_list_versions')).rows).toEqual([]);
    });
  });

  it('carries the encounter of the reading it corrects, and sets an encounter once only', async () => {
    const token = await addToken(patients.adult);
    const original = await recorded(patients.adult, { pulse: 180, queueTokenId: token });
    const encounterId = await addEncounter(patients.adult);
    await pool.query('update vitals set encounter_id = $2 where id = $1', [
      original.id,
      encounterId,
    ]);
    const correction = await recorded(patients.adult, {
      pulse: 80,
      correctsId: original.id,
      correctionReason: 'Typo',
    });
    expect(correction).toMatchObject({ queueTokenId: token, encounterId });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('update vitals set encounter_id = $2 where id = $1', [
          original.id,
          randomUUID(),
        ]),
      ).rejects.toThrow();
    });
  });

  it('refuses another hospital’s token and another patient’s reading', async () => {
    const { rows } = await pool.query<{ id: string }>(
      "insert into departments (tenant_id, name) values ($1, 'Clinic General') returning id",
      [clinic.id],
    );
    const { rows: tokens } = await pool.query<{ id: string }>(
      `insert into queue_tokens (tenant_id, day, department_id, number, patient_id, issued_by)
       select $1, (now() at time zone timezone)::date, $2, 1, $3, $4 from tenants where id = $1
       returning id`,
      [clinic.id, rows[0]?.id, patients.clinic, clinicNurse.id],
    );
    expect(
      errorOf(await record(patients.adult, { pulse: 70, queueTokenId: tokens[0]?.id })),
    ).toEqual([422, 'token_not_for_patient']);
    const theirs = await recorded(patients.other, { pulse: 70 });
    expect(
      errorOf(
        await record(patients.adult, { pulse: 72, correctsId: theirs.id, correctionReason: 'x' }),
      ),
    ).toEqual([422, 'unknown_correction']);
    await pool.query('delete from queue_tokens where tenant_id = $1', [clinic.id]);
  });
});
