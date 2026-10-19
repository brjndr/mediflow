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
 * The clinical API through the real app and database: opening an encounter from a token, an
 * appointment or a walk-in; notes that are drafted, signed and amended with their history kept;
 * diagnoses recorded and retracted; orders and their states; prescriptions and their revisions;
 * the hospital boundary, permissions and scope, audit and events.
 */

let app: FastifyInstance;
let jobs: MemoryQueue;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** The clinical module switched off. */
let closed: TestTenant;
let admin: TestUser;
let doctor: TestUser;
/** A doctor of another department, to test scope. */
let colleague: TestUser;
let nurse: TestUser;
let desk: TestUser;
let clinicDoctor: TestUser;
const departments = { general: '', ortho: '' };
const doctors = { doctor: '', colleague: '', clinic: '' };
const patients = { asha: '', bala: '', clinic: '' };
const catalog = {
  labTest: '',
  imaging: '',
  procedure: '',
  drug: '',
  archivedDrug: '',
  longDrug: '',
  code: '',
};
const codeValue = `Z${Math.floor(Math.random() * 90 + 10)}.${Math.floor(Math.random() * 9)}T`;

interface Encounter {
  id: string;
  tenantId: string;
  patientId: string;
  patientName: string;
  type: string;
  status: string;
  queueTokenId?: string;
  appointmentId?: string;
  attendingDoctorId?: string;
  departmentId?: string;
  endedAt?: string;
  cancelReason?: string;
  version: number;
}
interface Note {
  id: string;
  encounterId: string;
  status: string;
  body: { type: string; content: unknown[] };
  authorId: string;
  amendsId?: string;
  amendmentReason?: string;
  amendedById?: string;
  version: number;
}
interface Diagnosis {
  id: string;
  codeId?: string;
  code?: string;
  codeTitle?: string;
  text?: string;
  kind: string;
  retractedAt?: string;
  retractionReason?: string;
}
interface Order {
  id: string;
  type: string;
  status: string;
  itemName?: string;
  itemCode?: string;
  prescriptionId?: string;
  dose?: string;
  cancelReason?: string;
  version: number;
}
interface Prescription {
  id: string;
  replacesId?: string;
  replacedById?: string;
  lines: Order[];
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
type Reply = {
  statusCode: number;
  body: string;
  json: <T = { error: { code: string } }>() => T;
};

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const get = (url: string, options: Options = {}) =>
  app.inject({ url, headers: as((options.tenant ?? hospital).id, (options.user ?? doctor).id) });
const send = (
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: object,
  options: Options = {},
) => {
  const { tenant = hospital, user = doctor, key = randomUUID() } = options;
  return app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), ...(key === null ? {} : { 'idempotency-key': key }) },
    ...(body === undefined ? {} : { payload: body }),
  });
};
const post = (url: string, body: object, options: Options = {}) => send('POST', url, body, options);
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

async function ok<T>(response: Promise<Reply> | Reply, status = 201): Promise<T> {
  const reply = await response;
  if (reply.statusCode !== status) {
    throw new Error(`expected ${status}, got ${reply.statusCode} ${reply.body}`);
  }
  return reply.json<T>();
}

const open = (body: object = { patientId: patients.asha }, options: Options = {}) =>
  ok<Encounter>(post('/encounters', body, options));
const draft = (encounterId: string, text = 'Fever for three days', options: Options = {}) =>
  ok<Note>(post(`/encounters/${encounterId}/notes`, { body: doc(text) }, options));
const sign = (note: Note, options: Options = {}) =>
  ok<Note>(post(`/notes/${note.id}/sign`, { version: note.version }, options), 200);
const placeLab = (encounterId: string, options: Options = {}) =>
  ok<Order>(
    post(`/encounters/${encounterId}/orders`, { type: 'lab', labTestId: catalog.labTest }, options),
  );
const line = (overrides: object = {}) => ({
  drugId: catalog.drug,
  dose: '500 mg',
  route: 'oral',
  frequency: '1-0-1',
  durationDays: 5,
  quantity: 10,
  ...overrides,
});

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

const tenants = () => [hospital.id, clinic.id, closed.id];

/**
 * Removes what the tests wrote. Signed notes are never removed by anyone else: the guard trigger
 * refuses it, so the triggers are set aside for this transaction only.
 */
const clearClinical = async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'orders',
      'prescriptions',
      'encounter_diagnoses',
      'clinical_notes',
      'vitals',
      'encounters',
      'queue_tokens',
      'appointments',
      'outbox',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
};

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Test', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CL-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

async function addDepartment(tenant: TestTenant, name: string) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, name],
  );
  return rows[0]?.id ?? '';
}

async function addDoctor(tenant: TestTenant, user: TestUser, departmentId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General', 15) returning id`,
    [tenant.id, user.id, departmentId],
  );
  return rows[0]?.id ?? '';
}

/** A token of today at the hospital, for a doctor or for the department. */
async function addToken(
  patientId: string,
  doctorId: string | null = null,
  appointmentId: string | null = null,
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into queue_tokens (tenant_id, day, department_id, number, patient_id, issued_by,
                               doctor_id, appointment_id)
     select $1, (now() at time zone timezone)::date, $2,
            coalesce((select max(number) from queue_tokens where tenant_id = $1), 0) + 1, $3, $4,
            $5, $6
     from tenants where id = $1
     returning id`,
    [hospital.id, departments.general, patientId, desk.id, doctorId, appointmentId],
  );
  return rows[0]?.id ?? '';
}

let appointmentHour = 0;
async function addAppointment(patientId: string, cancelled = false) {
  appointmentHour += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, created_by)
     values ($1, $2, $3, now() + make_interval(hours => $4), now() + make_interval(hours => $4, mins => 15), $5)
     returning id`,
    [hospital.id, patientId, doctors.doctor, appointmentHour, desk.id],
  );
  const id = rows[0]?.id ?? '';
  if (cancelled) {
    await pool.query(
      "update appointments set status = 'cancelled', cancel_reason = 'duplicate' where id = $1",
      [id],
    );
  }
  return id;
}

beforeAll(async () => {
  jobs = new MemoryQueue();
  app = await buildTestApp({ resolveSession: resolveTestSession, jobQueue: jobs });
  pool = app.database.pool;
  const features = { clinical: true, patients: true, appointments: true, queue: true };
  hospital = await createTenant(pool, 'Clinical Hospital', { features });
  clinic = await createTenant(pool, 'Clinical Clinic', { features });
  closed = await createTenant(pool, 'Clinical Closed', {
    features: { ...features, clinical: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Clinical Admin');
  doctor = await user('Clinical Doctor');
  colleague = await user('Clinical Colleague');
  nurse = await user('Clinical Nurse');
  desk = await user('Clinical Desk');
  clinicDoctor = await user('Clinic Doctor');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, closed, 'doctor');
  await addMembership(pool, colleague, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, clinicDoctor, clinic, 'doctor');
  departments.general = await addDepartment(hospital, 'General');
  departments.ortho = await addDepartment(hospital, 'Orthopaedics');
  const clinicDepartment = await addDepartment(clinic, 'General');
  doctors.doctor = await addDoctor(hospital, doctor, departments.general);
  doctors.colleague = await addDoctor(hospital, colleague, departments.ortho);
  doctors.clinic = await addDoctor(clinic, clinicDoctor, clinicDepartment);
  patients.asha = await addPatient(hospital, 'Asha');
  patients.bala = await addPatient(hospital, 'Bala');
  patients.clinic = await addPatient(clinic, 'Dina');

  const one = async (sql: string, values: unknown[]) =>
    (await pool.query<{ id: string }>(sql, values)).rows[0]?.id ?? '';
  catalog.labTest = await one(
    `insert into lab_tests (tenant_id, code, name, department, kind, result_type, sample_type, turnaround_hours)
     values ($1, 'CBC', 'Complete blood count', 'haematology', 'panel', 'text', 'blood', 4) returning id`,
    [hospital.id],
  );
  const service = (code: string, name: string, category: string) =>
    one(
      `insert into services (tenant_id, code, name, category, tax_class)
       values ($1, $2, $3, $4, 'exempt') returning id`,
      [hospital.id, code, name, category],
    );
  catalog.imaging = await service('XR-CH', 'Chest X-ray', 'imaging');
  catalog.procedure = await service('DRS', 'Dressing', 'procedure');
  const drug = (name: string, archived: boolean) =>
    one(
      `insert into drugs (tenant_id, type, generic_name, form, strength, schedule, tax_class, archived)
       values ($1, 'medicine', $2, 'tablet', '500 mg', 'none', 'exempt', $3) returning id`,
      [hospital.id, name, archived],
    );
  catalog.drug = await drug('Paracetamol', false);
  catalog.archivedDrug = await drug('Old Drug', true);
  // Every part of its name at the longest the catalog takes.
  catalog.longDrug = await one(
    `insert into drugs (tenant_id, type, generic_name, brand_name, form, strength, schedule, tax_class)
     values ($1, 'medicine', $2, $3, 'tablet', $4, 'none', 'exempt') returning id`,
    [hospital.id, 'G'.repeat(150), 'B'.repeat(150), 'S'.repeat(30)],
  );
  catalog.code = await one(
    "insert into codes (system, code, title) values ('icd10', $1, 'Test fever') returning id",
    [codeValue],
  );
});

afterEach(clearClinical);

afterAll(async () => {
  await clearClinical();
  for (const table of ['doctors', 'lab_tests', 'services', 'drugs', 'patients', 'departments']) {
    await pool.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
  }
  await pool.query('delete from codes where id = $1', [catalog.code]);
  await deleteUsers(pool, [admin, doctor, colleague, nurse, desk, clinicDoctor]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('opening an encounter', () => {
  it('opens a walk-in with the caller as the doctor, audits it and emits encounter.opened', async () => {
    const encounter = await open();
    expect(encounter).toMatchObject({
      tenantId: hospital.id,
      patientId: patients.asha,
      patientName: 'Asha Test',
      type: 'opd',
      status: 'open',
      attendingDoctorId: doctors.doctor,
      departmentId: departments.general,
      version: 1,
    });
    expect(await audited('encounter', encounter.id)).toEqual(['create']);
    expect(await events(encounter.id)).toEqual([
      {
        event: 'encounter.opened',
        payload: {
          encounterId: encounter.id,
          patientId: patients.asha,
          type: 'opd',
          doctorId: doctors.doctor,
          departmentId: departments.general,
        },
      },
    ]);
  });

  it('opens from a token once, and the token’s readings join it', async () => {
    const token = await addToken(patients.asha, doctors.colleague);
    await pool.query(
      `insert into vitals (tenant_id, patient_id, queue_token_id, recorded_by, pulse)
       values ($1, $2, $3, $4, 80)`,
      [hospital.id, patients.asha, token, nurse.id],
    );
    const encounter = await open({ patientId: patients.asha, queueTokenId: token });
    expect(encounter).toMatchObject({ queueTokenId: token, attendingDoctorId: doctors.colleague });
    expect((await events(encounter.id))[0]?.payload).toMatchObject({ queueTokenId: token });

    // Asked again, with another key: the same encounter.
    const again = await ok<Encounter>(
      post('/encounters', { patientId: patients.asha, queueTokenId: token }),
      200,
    );
    expect(again.id).toBe(encounter.id);

    // The triage subscriber attaches the readings.
    await app.events.dispatch();
    await jobs.drain();
    const { rows } = await pool.query('select encounter_id from vitals where queue_token_id = $1', [
      token,
    ]);
    expect(rows).toEqual([{ encounter_id: encounter.id }]);
  });

  it('opens from an appointment, and refuses one that is cancelled or another patient’s', async () => {
    const appointment = await addAppointment(patients.asha);
    const encounter = await open({ patientId: patients.asha, appointmentId: appointment });
    expect(encounter).toMatchObject({
      appointmentId: appointment,
      attendingDoctorId: doctors.doctor,
    });
    expect(
      errorOf(await post('/encounters', { patientId: patients.bala, appointmentId: appointment })),
    ).toEqual([422, 'unknown_appointment']);
    const cancelled = await addAppointment(patients.bala, true);
    expect(
      errorOf(await post('/encounters', { patientId: patients.bala, appointmentId: cancelled })),
    ).toEqual([409, 'invalid_transition']);
  });

  it('refuses a token that is not the patient’s, an unknown patient and an unknown doctor', async () => {
    const token = await addToken(patients.bala);
    expect(
      errorOf(await post('/encounters', { patientId: patients.asha, queueTokenId: token })),
    ).toEqual([422, 'token_not_for_patient']);
    expect(errorOf(await post('/encounters', { patientId: patients.clinic }))).toEqual([
      422,
      'unknown_patient',
    ]);
    expect(
      errorOf(
        await post('/encounters', { patientId: patients.asha, attendingDoctorId: doctors.clinic }),
      ),
    ).toEqual([422, 'unknown_doctor']);
    // The admin has no doctor profile and names none.
    expect(
      errorOf(await post('/encounters', { patientId: patients.asha }, { user: admin })),
    ).toEqual([422, 'unknown_doctor']);
  });

  it('answers a repeated key with the encounter and opens nothing more', async () => {
    const key = randomUUID();
    const first = await open({ patientId: patients.asha }, { key });
    const repeat = await post('/encounters', { patientId: patients.asha }, { key });
    expect(repeat.statusCode).toBe(201);
    expect(repeat.headers['idempotent-replayed']).toBe('true');
    expect(repeat.json<Encounter>().id).toBe(first.id);
    const { rows } = await pool.query('select id from encounters where tenant_id = $1', [
      hospital.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(errorOf(await post('/encounters', { patientId: patients.asha }, { key: null }))).toEqual(
      [400, 'validation_failed'],
    );
  });

  it('opens one encounter for a token when two doctors start it at the same moment', async () => {
    const token = await addToken(patients.asha);
    const results = await Promise.all([
      post('/encounters', { patientId: patients.asha, queueTokenId: token }),
      post('/encounters', { patientId: patients.asha, queueTokenId: token }, { user: colleague }),
    ]);
    const statuses = results.map((reply) => reply.statusCode);
    expect(statuses).toContain(201);
    expect([200, 409]).toContain(statuses.find((status) => status !== 201));
    const { rows } = await pool.query('select id from encounters where queue_token_id = $1', [
      token,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('closing and cancelling', () => {
  it('closes an encounter once, and refuses with a draft still open', async () => {
    const encounter = await open();
    const note = await draft(encounter.id);
    expect(
      errorOf(await post(`/encounters/${encounter.id}/close`, { version: encounter.version })),
    ).toEqual([409, 'unsigned_notes']);
    await sign(note);
    expect(errorOf(await post(`/encounters/${encounter.id}/close`, { version: 9 }))).toEqual([
      409,
      'conflict',
    ]);
    const closedOne = await ok<Encounter>(
      post(`/encounters/${encounter.id}/close`, { version: encounter.version }),
      200,
    );
    expect(closedOne).toMatchObject({ status: 'closed', version: 2 });
    expect(closedOne.endedAt).toBeDefined();
    expect((await events(encounter.id)).map((row) => row.event)).toEqual([
      'encounter.opened',
      'encounter.closed',
    ]);
    expect(errorOf(await post(`/encounters/${encounter.id}/close`, { version: 2 }))).toEqual([
      409,
      'invalid_transition',
    ]);
    // Nothing new is added to a closed encounter.
    expect(errorOf(await post(`/encounters/${encounter.id}/notes`, { body: doc('Late') }))).toEqual(
      [409, 'encounter_not_open'],
    );
  });

  it('cancels only an encounter with nothing on its record, and its token may open again', async () => {
    const token = await addToken(patients.asha);
    const encounter = await open({ patientId: patients.asha, queueTokenId: token });
    await placeLab(encounter.id);
    expect(
      errorOf(
        await post(`/encounters/${encounter.id}/cancel`, { version: 1, reason: 'Wrong patient' }),
      ),
    ).toEqual([409, 'has_records']);
    const other = await open({ patientId: patients.bala });
    const cancelled = await ok<Encounter>(
      post(`/encounters/${other.id}/cancel`, { version: 1, reason: '  Opened  by mistake ' }),
      200,
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Opened by mistake' });
    expect((await events(other.id)).map((row) => row.event)).toContain('encounter.cancelled');
  });
});

describe('notes and their history', () => {
  it('keeps a draft its author edits, signs it, and the database refuses any change of it', async () => {
    const encounter = await open();
    const note = await draft(encounter.id, 'First words');
    expect(note).toMatchObject({ status: 'draft', authorId: doctor.id, version: 1 });
    const saved = await ok<Note>(
      send('PATCH', `/notes/${note.id}`, { body: doc('Better words'), version: 1 }, { key: null }),
      200,
    );
    expect(saved).toMatchObject({ version: 2, body: doc('Better words') });
    expect(
      errorOf(
        await send('PATCH', `/notes/${note.id}`, { body: doc('Stale'), version: 1 }, { key: null }),
      ),
    ).toEqual([409, 'conflict']);
    // Another doctor does not see someone else's draft.
    expect(errorOf(await get(`/notes/${note.id}`, { user: colleague }))).toEqual([
      404,
      'note_not_found',
    ]);
    const signed = await sign(saved);
    expect(signed.status).toBe('signed');
    expect(
      errorOf(
        await send('PATCH', `/notes/${note.id}`, { body: doc('Edit'), version: 3 }, { key: null }),
      ),
    ).toEqual([409, 'note_signed']);
    expect(errorOf(await send('DELETE', `/notes/${note.id}`, undefined, { key: null }))).toEqual([
      409,
      'note_signed',
    ]);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update clinical_notes set body = '{}' where id = $1", [note.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('delete from clinical_notes where id = $1', [note.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await audited('clinical_note', note.id)).toEqual(['create', 'update', 'update']);
  });

  it('amends a signed note with a new one, once, and keeps the one it amends', async () => {
    const encounter = await open();
    const note = await sign(await draft(encounter.id, 'BP 150/95'));
    await ok(post(`/encounters/${encounter.id}/close`, { version: 1 }), 200);
    // After the encounter closed, and by another doctor.
    const amendment = await ok<Note>(
      post(
        `/notes/${note.id}/amendments`,
        { body: doc('BP 130/85'), reason: 'Wrong reading' },
        { user: colleague },
      ),
    );
    expect(amendment).toMatchObject({
      status: 'signed',
      amendsId: note.id,
      amendmentReason: 'Wrong reading',
      authorId: colleague.id,
    });
    expect(
      errorOf(await post(`/notes/${note.id}/amendments`, { body: doc('Again'), reason: 'More' })),
    ).toEqual([409, 'already_amended']);
    const page = await ok<Page<Note>>(get(`/encounters/${encounter.id}/notes`), 200);
    expect(page.items.map((item) => [item.id, item.amendedById])).toEqual([
      [note.id, amendment.id],
      [amendment.id, undefined],
    ]);
    expect(page.items[0]?.body).toEqual(doc('BP 150/95'));
    // The amendment is amended in turn: the history stays one line.
    await ok(post(`/notes/${amendment.id}/amendments`, { body: doc('BP 132/85'), reason: 'Typo' }));
    // A draft is edited, not amended.
    const other = await open({ patientId: patients.bala });
    const pending = await draft(other.id);
    expect(
      errorOf(await post(`/notes/${pending.id}/amendments`, { body: doc('X'), reason: 'Y' })),
    ).toEqual([409, 'note_not_signed']);
  });

  it('discards a draft and refuses an empty note', async () => {
    const encounter = await open();
    const note = await draft(encounter.id);
    expect((await send('DELETE', `/notes/${note.id}`, undefined, { key: null })).statusCode).toBe(
      204,
    );
    expect(errorOf(await get(`/notes/${note.id}`))).toEqual([404, 'note_not_found']);
    expect(
      errorOf(
        await post(`/encounters/${encounter.id}/notes`, { body: { type: 'doc', content: [] } }),
      ),
    ).toEqual([400, 'validation_failed']);
    // Anything outside the allowlist is dropped.
    const cleaned = await draft(encounter.id);
    const withScript = await ok<Note>(
      send(
        'PATCH',
        `/notes/${cleaned.id}`,
        {
          body: { type: 'doc', content: [{ type: 'script', text: 'x' }, ...doc('Kept').content] },
          version: 1,
        },
        { key: null },
      ),
      200,
    );
    expect(withScript.body).toEqual(doc('Kept'));
  });
});

describe('diagnoses', () => {
  it('records a coded diagnosis as the code read, and retracts it once with a reason', async () => {
    const encounter = await open();
    const diagnosis = await ok<Diagnosis>(
      post(`/encounters/${encounter.id}/diagnoses`, { codeId: catalog.code, kind: 'provisional' }),
    );
    expect(diagnosis).toMatchObject({
      codeId: catalog.code,
      code: codeValue,
      codeTitle: 'Test fever',
    });
    const text = await ok<Diagnosis>(
      post(`/encounters/${encounter.id}/diagnoses`, { text: ' Viral  fever ', kind: 'final' }),
    );
    expect(text.text).toBe('Viral fever');
    expect(errorOf(await post(`/encounters/${encounter.id}/diagnoses`, { kind: 'final' }))).toEqual(
      [400, 'validation_failed'],
    );
    expect(
      errorOf(
        await post(`/encounters/${encounter.id}/diagnoses`, {
          codeId: randomUUID(),
          kind: 'final',
        }),
      ),
    ).toEqual([422, 'unknown_code']);
    const retracted = await ok<Diagnosis>(
      post(`/diagnoses/${diagnosis.id}/retract`, { reason: 'Ruled out' }),
      200,
    );
    expect(retracted).toMatchObject({ retractionReason: 'Ruled out' });
    expect(errorOf(await post(`/diagnoses/${diagnosis.id}/retract`, { reason: 'Again' }))).toEqual([
      409,
      'already_retracted',
    ]);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update encounter_diagnoses set kind = 'final' where id = $1", [text.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const page = await ok<Page<Diagnosis>>(get(`/encounters/${encounter.id}/diagnoses`), 200);
    expect(page.items).toHaveLength(2);
  });

  it('is a permission of its own: the nurse sees the encounter and its orders, not its diagnoses or notes', async () => {
    const encounter = await open();
    await placeLab(encounter.id);
    expect((await get(`/encounters/${encounter.id}`, { user: nurse })).statusCode).toBe(200);
    expect((await get(`/encounters/${encounter.id}/orders`, { user: nurse })).statusCode).toBe(200);
    expect(errorOf(await get(`/encounters/${encounter.id}/diagnoses`, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await get(`/encounters/${encounter.id}/notes`, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect((await get(`/encounters/${encounter.id}/diagnoses`, { user: admin })).statusCode).toBe(
      200,
    );
  });
});

describe('orders', () => {
  it('places each type with the item as it read, and emits order.placed', async () => {
    const encounter = await open();
    const lab = await placeLab(encounter.id);
    expect(lab).toMatchObject({
      type: 'lab',
      status: 'placed',
      itemCode: 'CBC',
      itemName: 'Complete blood count',
    });
    expect(await events(lab.id)).toEqual([
      {
        event: 'order.placed',
        payload: {
          orderId: lab.id,
          encounterId: encounter.id,
          patientId: patients.asha,
          type: 'lab',
          labTestId: catalog.labTest,
          priority: 'routine',
        },
      },
    ]);
    const imaging = await ok<Order>(
      post(`/encounters/${encounter.id}/orders`, {
        type: 'imaging',
        serviceId: catalog.imaging,
        priority: 'stat',
      }),
    );
    expect(imaging).toMatchObject({ itemName: 'Chest X-ray' });
    const diet = await ok<Order>(
      post(`/encounters/${encounter.id}/orders`, { type: 'diet', instructions: 'Soft diet' }),
    );
    expect(diet.itemName).toBeUndefined();
    // An imaging service is not a procedure; a lab order takes no service.
    expect(
      errorOf(
        await post(`/encounters/${encounter.id}/orders`, {
          type: 'procedure',
          serviceId: catalog.imaging,
        }),
      ),
    ).toEqual([422, 'unknown_service']);
    for (const body of [
      { type: 'lab' },
      { type: 'lab', labTestId: catalog.labTest, serviceId: catalog.imaging },
      { type: 'diet' },
      { type: 'medication' },
    ]) {
      expect(errorOf(await post(`/encounters/${encounter.id}/orders`, body))).toEqual([
        400,
        'validation_failed',
      ]);
    }
    expect(await audited('order', lab.id)).toEqual(['create']);
  });

  it('moves an order on one step at a time, and cancels only one not started', async () => {
    const encounter = await open();
    const order = await placeLab(encounter.id);
    expect(
      errorOf(await post(`/orders/${order.id}/status`, { status: 'completed', version: 1 })),
    ).toEqual([409, 'invalid_transition']);
    const accepted = await ok<Order>(
      post(`/orders/${order.id}/status`, { status: 'accepted', version: 1 }, { user: nurse }),
      200,
    );
    expect(accepted).toMatchObject({ status: 'accepted', version: 2 });
    await ok(post(`/orders/${order.id}/status`, { status: 'in_progress', version: 2 }), 200);
    expect(
      errorOf(await post(`/orders/${order.id}/cancel`, { version: 3, reason: 'Not needed' })),
    ).toEqual([409, 'invalid_transition']);
    await ok(post(`/orders/${order.id}/status`, { status: 'completed', version: 3 }), 200);
    expect((await events(order.id)).map((row) => row.event)).toEqual([
      'order.placed',
      'order.completed',
    ]);
    // The database holds the states too.
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update orders set status = 'placed' where id = $1", [order.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const other = await placeLab(encounter.id);
    const cancelled = await ok<Order>(
      post(`/orders/${other.id}/cancel`, { version: 1, reason: 'Ordered twice' }),
      200,
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Ordered twice' });
    // A nurse moves orders on but does not cancel them.
    const third = await placeLab(encounter.id);
    expect(
      errorOf(
        await post(`/orders/${third.id}/cancel`, { version: 1, reason: 'No' }, { user: nurse }),
      ),
    ).toEqual([403, 'permission_denied']);
  });
});

describe('prescriptions', () => {
  it('writes the lines as medication orders, and a revision replaces it once', async () => {
    const encounter = await open();
    const first = await ok<Prescription>(
      post(`/encounters/${encounter.id}/prescriptions`, {
        lines: [line(), line({ dose: '1 tablet', frequency: '0-0-1' })],
        advice: 'Rest and fluids',
      }),
    );
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0]).toMatchObject({
      type: 'medication',
      status: 'placed',
      prescriptionId: first.id,
      itemName: 'Paracetamol 500 mg',
      dose: '500 mg',
    });
    // One line has started: it stays when the prescription is replaced.
    const started = first.lines[1];
    if (!started) throw new Error('no second line');
    await ok(post(`/orders/${started.id}/status`, { status: 'accepted', version: 1 }), 200);
    await ok(post(`/orders/${started.id}/status`, { status: 'in_progress', version: 2 }), 200);

    const revised = await ok<Prescription>(
      post(`/encounters/${encounter.id}/prescriptions`, {
        lines: [line({ dose: '650 mg' })],
        replacesId: first.id,
        replaceReason: 'Dose too low',
      }),
    );
    expect(revised.replacesId).toBe(first.id);
    const old = await ok<Prescription>(get(`/prescriptions/${first.id}`), 200);
    expect(old.replacedById).toBe(revised.id);
    expect(old.lines.map((order) => order.status)).toEqual(['cancelled', 'in_progress']);
    expect(
      errorOf(
        await post(`/encounters/${encounter.id}/prescriptions`, {
          lines: [line()],
          replacesId: first.id,
          replaceReason: 'Again',
        }),
      ),
    ).toEqual([409, 'already_replaced']);
    const cancelledLine = old.lines[0];
    if (!cancelledLine) throw new Error('no first line');
    expect((await events(cancelledLine.id)).map((row) => row.event)).toEqual([
      'order.placed',
      'order.cancelled',
    ]);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update prescriptions set advice = 'x' where id = $1", [first.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an archived drug, a reason without a replacement and too many lines', async () => {
    const encounter = await open();
    const url = `/encounters/${encounter.id}/prescriptions`;
    expect(errorOf(await post(url, { lines: [line({ drugId: catalog.archivedDrug })] }))).toEqual([
      422,
      'unknown_drug',
    ]);
    expect(errorOf(await post(url, { lines: [line()], replaceReason: 'Why' }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect(errorOf(await post(url, { lines: Array.from({ length: 31 }, () => line()) }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect(errorOf(await post(url, { lines: [line({ route: 'by mouth' })] }))).toEqual([
      400,
      'validation_failed',
    ]);
    const { rows } = await pool.query('select id from orders where encounter_id = $1', [
      encounter.id,
    ]);
    expect(rows).toEqual([]);
  });
});

describe('the hospital boundary, the module switch and scope', () => {
  it('answers another hospital’s encounter and its records as if they did not exist', async () => {
    const encounter = await open();
    const order = await placeLab(encounter.id);
    const note = await sign(await draft(encounter.id));
    const asClinic = { tenant: clinic, user: clinicDoctor };
    expect(errorOf(await get(`/encounters/${encounter.id}`, asClinic))).toEqual([
      404,
      'encounter_not_found',
    ]);
    expect(errorOf(await get(`/orders/${order.id}`, asClinic))).toEqual([404, 'order_not_found']);
    expect(errorOf(await get(`/notes/${note.id}`, asClinic))).toEqual([404, 'note_not_found']);
    expect(
      errorOf(
        await post(
          `/encounters/${encounter.id}/orders`,
          { type: 'diet', instructions: 'x' },
          asClinic,
        ),
      ),
    ).toEqual([404, 'encounter_not_found']);
    const page = await ok<Page<Encounter>>(get('/encounters', asClinic), 200);
    expect(page.items).toEqual([]);
  });

  it('keeps every clinical table to its hospital under the app role', async () => {
    const encounter = await open();
    await placeLab(encounter.id);
    await sign(await draft(encounter.id));
    await ok(post(`/encounters/${encounter.id}/diagnoses`, { text: 'Fever', kind: 'final' }));
    await ok(post(`/encounters/${encounter.id}/prescriptions`, { lines: [line()] }));
    for (const table of [
      'encounters',
      'clinical_notes',
      'encounter_diagnoses',
      'orders',
      'prescriptions',
    ]) {
      const seen = await asTenantSql(pool, clinic.id, (client) =>
        client.query(`select id from ${table}`),
      );
      expect(seen.rows, table).toEqual([]);
      const own = await asTenantSql(pool, hospital.id, (client) =>
        client.query(`select id from ${table}`),
      );
      expect(own.rows.length, table).toBeGreaterThan(0);
    }
    // Nor written into another hospital: an encounter of the clinic for the hospital's patient.
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into encounters (tenant_id, patient_id, type, opened_by)
           values ($1, $2, 'opd', $3)`,
          [hospital.id, patients.asha, clinicDoctor.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into clinical_notes (tenant_id, encounter_id, patient_id, body, author_id)
           values ($1, $2, $3, '{}', $4)`,
          [clinic.id, encounter.id, patients.asha, clinicDoctor.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('is closed with the module off and to a role without the permission', async () => {
    expect(
      errorOf(await post('/encounters', { patientId: patients.asha }, { tenant: closed })),
    ).toEqual([403, 'feature_disabled']);
    expect(
      errorOf(await post('/encounters', { patientId: patients.asha }, { user: desk })),
    ).toEqual([403, 'permission_denied']);
    expect(errorOf(await get('/encounters', { user: desk }))).toEqual([403, 'permission_denied']);
    expect(
      errorOf(await post('/encounters', { patientId: patients.asha }, { user: nurse })),
    ).toEqual([403, 'permission_denied']);
  });

  it('narrows to the caller’s own encounters, or their department’s, by the scope of the grant', async () => {
    const mine = await open();
    const theirs = await open({ patientId: patients.bala }, { user: colleague });
    const restrict = async (permission: string, scope: string) =>
      pool.query(
        `update role_permissions set scope = $3
         where tenant_id = $1 and permission = $2
           and role_id = 'doctor'`,
        [hospital.id, permission, scope],
      );
    try {
      await restrict('encounter:read', 'own');
      const page = await ok<Page<Encounter>>(get('/encounters'), 200);
      expect(page.items.map((item) => item.id)).toEqual([mine.id]);
      expect(errorOf(await get(`/encounters/${theirs.id}`))).toEqual([404, 'encounter_not_found']);
      await restrict('encounter:read', 'department');
      const department = await ok<Page<Encounter>>(get('/encounters', { user: colleague }), 200);
      expect(department.items.map((item) => item.id)).toEqual([theirs.id]);
      // `own` opening: only as oneself.
      await restrict('encounter:create', 'own');
      expect(
        errorOf(
          await post('/encounters', {
            patientId: patients.bala,
            attendingDoctorId: doctors.colleague,
          }),
        ),
      ).toEqual([422, 'unknown_doctor']);
    } finally {
      await restrict('encounter:read', 'all');
      await restrict('encounter:create', 'all');
    }
  });

  it('lists a patient’s encounters newest first, a page at a time, and audits each row', async () => {
    const first = await open();
    await ok(post(`/encounters/${first.id}/close`, { version: 1 }), 200);
    const second = await open();
    await open({ patientId: patients.bala });
    const page = await ok<Page<Encounter>>(
      get(`/encounters?patientId=${patients.asha}&limit=1`),
      200,
    );
    expect(page.items.map((item) => item.id)).toEqual([second.id]);
    expect(page.total).toBe(2);
    const next = await ok<Page<Encounter>>(
      get(`/encounters?patientId=${patients.asha}&limit=1&cursor=${page.nextCursor ?? ''}`),
      200,
    );
    expect(next.items.map((item) => item.id)).toEqual([first.id]);
    expect(next.nextCursor).toBeNull();
    // The whole hospital's encounters are not counted.
    const open_ = await ok<Page<Encounter>>(get('/encounters?status=open'), 200);
    expect(open_.items).toHaveLength(2);
    expect(open_.total).toBeUndefined();
    expect(errorOf(await get('/encounters?cursor=nonsense'))).toEqual([400, 'invalid_cursor']);
    expect(await audited('encounter', first.id)).toContain('read');
  });
});

describe('a whole OPD visit', () => {
  it('opens from the token, records, orders, prescribes and closes, with every event and audit', async () => {
    const token = await addToken(patients.asha, doctors.doctor);
    const encounter = await open({ patientId: patients.asha, queueTokenId: token });
    const note = await sign(await draft(encounter.id, 'Cough and fever for three days'));
    const diagnosis = await ok<Diagnosis>(
      post(`/encounters/${encounter.id}/diagnoses`, { codeId: catalog.code, kind: 'provisional' }),
    );
    const lab = await placeLab(encounter.id);
    const prescription = await ok<Prescription>(
      post(`/encounters/${encounter.id}/prescriptions`, { lines: [line()] }),
    );
    const medication = prescription.lines[0];
    if (!medication) throw new Error('no line');
    let version = lab.version;
    for (const status of ['accepted', 'in_progress', 'completed']) {
      version = (
        await ok<Order>(post(`/orders/${lab.id}/status`, { status, version }, { user: nurse }), 200)
      ).version;
    }
    const closedOne = await ok<Encounter>(
      post(`/encounters/${encounter.id}/close`, { version: encounter.version }),
      200,
    );
    expect(closedOne.status).toBe('closed');

    const orders = await ok<Page<Order>>(get(`/encounters/${encounter.id}/orders`), 200);
    expect(orders.items.map((order) => [order.type, order.status])).toEqual(
      expect.arrayContaining([
        ['lab', 'completed'],
        ['medication', 'placed'],
      ]),
    );
    expect((await events(encounter.id)).map((row) => row.event)).toEqual([
      'encounter.opened',
      'encounter.closed',
    ]);
    expect((await events(lab.id)).map((row) => row.event)).toEqual([
      'order.placed',
      'order.completed',
    ]);
    expect((await events(medication.id)).map((row) => row.event)).toEqual(['order.placed']);
    expect(await audited('encounter', encounter.id)).toEqual(['create', 'update']);
    expect(await audited('clinical_note', note.id)).toEqual(['create', 'update']);
    expect(await audited('diagnosis', diagnosis.id)).toEqual(['create']);
    expect(await audited('prescription', prescription.id)).toEqual(['create']);
    expect(await audited('order', lab.id)).toEqual([
      'create',
      'update',
      'update',
      'update',
      'read',
    ]);
    // No event carries clinical text.
    const { rows } = await pool.query<{ payload: string }>(
      'select payload::text as payload from outbox where tenant_id = $1',
      [hospital.id],
    );
    for (const { payload } of rows) {
      expect(payload).not.toMatch(/Cough|500 mg|1-0-1|Test fever/);
    }
  });
});

describe('what the reviews asked for', () => {
  it('takes the appointment of a checked-in token, and refuses another appointment with it', async () => {
    const appointment = await addAppointment(patients.asha);
    const token = await addToken(patients.asha, doctors.doctor, appointment);
    const other = await addAppointment(patients.asha);
    expect(
      errorOf(
        await post('/encounters', {
          patientId: patients.asha,
          queueTokenId: token,
          appointmentId: other,
        }),
      ),
    ).toEqual([422, 'unknown_appointment']);
    const encounter = await open({ patientId: patients.asha, queueTokenId: token });
    expect(encounter.appointmentId).toBe(appointment);
    // Opening from the appointment later finds the same visit.
    const again = await ok<Encounter>(
      post('/encounters', { patientId: patients.asha, appointmentId: appointment }),
      200,
    );
    expect(again.id).toBe(encounter.id);
    // A repeat of a key that first answered 200 answers 200 again.
    const key = randomUUID();
    await ok(post('/encounters', { patientId: patients.asha, queueTokenId: token }, { key }), 200);
    const repeat = await post(
      '/encounters',
      { patientId: patients.asha, queueTokenId: token },
      { key },
    );
    expect([repeat.statusCode, repeat.json<Encounter>().id]).toEqual([200, encounter.id]);
  });

  it('adds nothing to a closed encounter, and cancels none with a draft', async () => {
    const encounter = await open();
    const drafted = await draft(encounter.id);
    expect(
      errorOf(await post(`/encounters/${encounter.id}/cancel`, { version: 1, reason: 'Mistake' })),
    ).toEqual([409, 'unsigned_notes']);
    await sign(drafted);
    await ok(post(`/encounters/${encounter.id}/close`, { version: 1 }), 200);
    const attempts: [string, object][] = [
      [`/encounters/${encounter.id}/orders`, { type: 'diet', instructions: 'Soft' }],
      [`/encounters/${encounter.id}/diagnoses`, { text: 'Fever', kind: 'final' }],
      [`/encounters/${encounter.id}/prescriptions`, { lines: [line()] }],
    ];
    for (const [url, body] of attempts) {
      expect(errorOf(await post(url, body))).toEqual([409, 'encounter_not_open']);
    }
  });

  it('prescribes a drug with the longest name, and refuses a blank reason as a 400', async () => {
    const encounter = await open();
    const url = `/encounters/${encounter.id}/prescriptions`;
    const written = await ok<Prescription>(
      post(url, { lines: [line({ drugId: catalog.longDrug })] }),
    );
    expect(written.lines[0]?.itemName).toHaveLength(150 + 1 + 30 + 2 + 150 + 1);
    expect(errorOf(await post(url, { lines: [line()], replaceReason: '   ' }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect(
      errorOf(await post(url, { lines: [line()], replacesId: written.id, replaceReason: '   ' })),
    ).toEqual([400, 'validation_failed']);
  });

  it('answers another hospital’s diagnosis, prescription and order changes as if they did not exist', async () => {
    const encounter = await open();
    const diagnosis = await ok<Diagnosis>(
      post(`/encounters/${encounter.id}/diagnoses`, { text: 'Fever', kind: 'final' }),
    );
    const prescription = await ok<Prescription>(
      post(`/encounters/${encounter.id}/prescriptions`, { lines: [line()] }),
    );
    const order = await placeLab(encounter.id);
    const asClinic = { tenant: clinic, user: clinicDoctor };
    expect(errorOf(await get(`/prescriptions/${prescription.id}`, asClinic))).toEqual([
      404,
      'prescription_not_found',
    ]);
    expect(
      errorOf(await post(`/diagnoses/${diagnosis.id}/retract`, { reason: 'x' }, asClinic)),
    ).toEqual([404, 'diagnosis_not_found']);
    expect(
      errorOf(
        await post(`/orders/${order.id}/status`, { status: 'accepted', version: 1 }, asClinic),
      ),
    ).toEqual([404, 'order_not_found']);
    expect(
      errorOf(await post(`/orders/${order.id}/cancel`, { version: 1, reason: 'x' }, asClinic)),
    ).toEqual([404, 'order_not_found']);
    // The module off: the records of the encounter too.
    expect(errorOf(await get(`/orders/${order.id}`, { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('holds the scope of each record’s own permission to the encounter it belongs to', async () => {
    const theirs = await open({ patientId: patients.bala }, { user: colleague });
    const note = await sign(await draft(theirs.id, 'Theirs', { user: colleague }), {
      user: colleague,
    });
    const diagnosis = await ok<Diagnosis>(
      post(
        `/encounters/${theirs.id}/diagnoses`,
        { text: 'Sprain', kind: 'final' },
        { user: colleague },
      ),
    );
    const order = await placeLab(theirs.id, { user: colleague });
    const prescription = await ok<Prescription>(
      post(`/encounters/${theirs.id}/prescriptions`, { lines: [line()] }, { user: colleague }),
    );
    const restricted = [
      'clinicalNote:read',
      'diagnosis:write',
      'order:read',
      'order:update',
      'prescription:read',
    ];
    const setScope = (scope: string) =>
      pool.query(
        `update role_permissions set scope = $3
         where tenant_id = $1 and role_id = 'doctor' and permission = any($2)`,
        [hospital.id, restricted, scope],
      );
    try {
      await setScope('own');
      expect(errorOf(await get(`/notes/${note.id}`))).toEqual([404, 'note_not_found']);
      expect(errorOf(await get(`/encounters/${theirs.id}/notes`))).toEqual([
        404,
        'encounter_not_found',
      ]);
      expect(errorOf(await post(`/diagnoses/${diagnosis.id}/retract`, { reason: 'x' }))).toEqual([
        404,
        'diagnosis_not_found',
      ]);
      expect(errorOf(await get(`/orders/${order.id}`))).toEqual([404, 'order_not_found']);
      expect(errorOf(await get(`/encounters/${theirs.id}/orders`))).toEqual([
        404,
        'encounter_not_found',
      ]);
      expect(
        errorOf(await post(`/orders/${order.id}/status`, { status: 'accepted', version: 1 })),
      ).toEqual([404, 'order_not_found']);
      expect(errorOf(await get(`/prescriptions/${prescription.id}`))).toEqual([
        404,
        'prescription_not_found',
      ]);
      // The colleague still reaches their own.
      expect((await get(`/orders/${order.id}`, { user: colleague })).statusCode).toBe(200);
      // `department`: a doctor of another department does not reach them either.
      await setScope('department');
      expect(errorOf(await get(`/orders/${order.id}`))).toEqual([404, 'order_not_found']);
    } finally {
      await setScope('all');
    }
    expect((await get(`/orders/${order.id}`)).statusCode).toBe(200);
  });
});
