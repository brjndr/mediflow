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
import { dosesPerDay } from './routes.js';

/**
 * Nursing and ward care through the real app and database: ward vital signs, the medication
 * chart, progress notes with history, the diet read, ward stock requests; the append-only
 * guarantees of the tables (to the owner too), the hospital boundary, scope, permissions, the
 * module switches, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** Nursing off. */
let closed: TestTenant;
let doctor: TestUser;
let doctor2: TestUser;
let nurse: TestUser;
let nurse2: TestUser;
let pharmacist: TestUser;
let clinicNurse: TestUser;
let closedNurse: TestUser;

let department: string;
let patientA = '';
let patientB = '';
let clinicPatient = '';
let admissionA = '';
let encounterA = '';
let admissionB = '';
let encounterB = '';
let clinicAdmission = '';
let drug = '';
let wardPlace = '';
let store = '';
let orderA = '';
let orderB = '';

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const headers = ({ tenant = hospital, user = nurse, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `nursing-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const send = (method: 'POST' | 'PATCH', url: string, body: object, options: Options = {}) =>
  app.inject({
    method,
    url,
    headers: headers({ ...options, key: method === 'POST' ? (options.key ?? fresh()) : undefined }),
    payload: body,
  });
const post = (url: string, body: object, options: Options = {}) => send('POST', url, body, options);
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

interface Vital {
  id: string;
  systolic?: number;
  observedAt: string;
  flags?: Record<string, string>;
  correctsId?: string;
  correctedById?: string;
}
interface Entry {
  id: string;
  outcome: string;
  doseGiven?: string;
  route?: string;
  scheduledAt: string;
  correctsId?: string;
  correctedById?: string;
  warnings?: string[];
}
interface Note {
  id: string;
  body: string;
  version: number;
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
}

const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const vitals = (
  admissionId: string,
  body: object = { systolic: 120, diastolic: 80 },
  o?: Options,
) => post(`/admissions/${admissionId}/vitals`, body, o);
const recordMar = (body: object, o?: Options) => post('/mar/entries', body, o);
const given = (orderId: string, hoursAgo: number, more: object = {}, admissionId = admissionA) =>
  recordMar({ admissionId, orderId, scheduledAt: hours(hoursAgo), outcome: 'given', ...more });

const count = async (table: string) =>
  Number(
    (
      await pool.query<{ n: string }>(`select count(*) as n from ${table} where tenant_id = $1`, [
        hospital.id,
      ])
    ).rows[0]?.n,
  );
const events = async (event: string) =>
  Number(
    (
      await pool.query<{ n: string }>(
        'select count(*) as n from outbox where tenant_id = $1 and event = $2',
        [hospital.id, event],
      )
    ).rows[0]?.n,
  );
const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);

async function one(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(sql, params);
  return rows[0]?.id ?? '';
}

let mrn = 0;
const addPatient = (tenant: TestTenant, first: string) =>
  one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Ward', '1975-05-01', 'male', '+91 9800000000', 'test') returning id`,
    [tenant.id, `NW-${String(++mrn).padStart(7, '0')}`, first],
  );

async function addOrder(
  tenant: TestTenant,
  admissionEncounter: string,
  patientId: string,
  frequency = '1-0-1',
) {
  const prescription = await one(
    `insert into prescriptions (tenant_id, encounter_id, patient_id, prescribed_by)
     values ($1, $2, $3, $4) returning id`,
    [tenant.id, admissionEncounter, patientId, doctor.id],
  );
  return one(
    `insert into orders (tenant_id, encounter_id, patient_id, type, drug_id, item_name,
                         prescription_id, line_number, dose, route, frequency, duration_days,
                         quantity, ordered_by, placed_at)
     values ($1, $2, $3, 'medication', $4, 'Paracetamol 500 mg', $5, 1, '500 mg', 'oral', $6, 5, 10, $7,
             now() - interval '200 hours')
     returning id`,
    [tenant.id, admissionEncounter, patientId, drug, prescription, frequency, doctor.id],
  );
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'ward_stock_requests',
      'progress_note_versions',
      'progress_notes',
      'mar_entries',
      'ward_vitals',
      'stock_indent_lines',
      'stock_indents',
      'inventory_counters',
      'orders',
      'prescriptions',
      'bed_assignments',
      'admissions',
      'encounters',
      'outbox',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = {
    features: {
      nursing: true,
      admissions: true,
      clinical: true,
      inventory: true,
      patients: true,
      doctors: true,
      departments: true,
    },
  };
  hospital = await createTenant(pool, 'Nursing Hospital', on);
  clinic = await createTenant(pool, 'Nursing Clinic', on);
  closed = await createTenant(pool, 'Nursing Closed', {
    features: { ...on.features, nursing: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  doctor = await createUser(pool, 'Ward Doctor', { withPassword: false });
  doctor2 = await createUser(pool, 'Ward Doctor Two', { withPassword: false });
  nurse = await createUser(pool, 'Ward Nurse', { withPassword: false });
  nurse2 = await createUser(pool, 'Ward Nurse Two', { withPassword: false });
  pharmacist = await createUser(pool, 'Ward Pharmacist', { withPassword: false });
  clinicNurse = await createUser(pool, 'Clinic Nurse', { withPassword: false });
  closedNurse = await createUser(pool, 'Closed Nurse', { withPassword: false });
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, doctor2, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, nurse2, hospital, 'nurse');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicNurse, clinic, 'nurse');
  await addMembership(pool, closedNurse, closed, 'nurse');
  const addDepartment = (tenant: TestTenant) =>
    one('insert into departments (tenant_id, name) values ($1, $2) returning id', [
      tenant.id,
      'Medicine',
    ]);
  department = await addDepartment(hospital);
  const clinicDepartment = await addDepartment(clinic);
  for (const [tenant, user, dept] of [
    [hospital, doctor, department],
    [hospital, doctor2, department],
    [clinic, doctor, clinicDepartment],
  ] as const) {
    await pool.query(
      `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
       values ($1, $2, $3, 'General', 15)`,
      [tenant.id, user.id, dept],
    );
  }
  patientA = await addPatient(hospital, 'Asha');
  patientB = await addPatient(hospital, 'Bina');
  clinicPatient = await addPatient(clinic, 'Clinic');
  drug = await one(
    `insert into drugs (tenant_id, type, generic_name, form, unit, schedule, tax_class)
     values ($1, 'medicine', 'Paracetamol', 'tablet', 'piece', 'none', 'standard') returning id`,
    [hospital.id],
  );
  wardPlace = await one(
    "insert into stock_locations (tenant_id, name, kind) values ($1, 'Ward One stock', 'ward') returning id",
    [hospital.id],
  );
  store = await one(
    "insert into stock_locations (tenant_id, name, kind) values ($1, 'Main store', 'store') returning id",
    [hospital.id],
  );
  const admit = async (patientId: string, tenant = hospital) =>
    ok<{ admission: { id: string; encounterId: string } }>(
      await post('/admissions', { patientId, admissionType: 'planned' }, { tenant, user: doctor }),
      201,
    );
  const a = await admit(patientA);
  admissionA = a.admission.id;
  encounterA = a.admission.encounterId;
  const b = await admit(patientB);
  admissionB = b.admission.id;
  encounterB = b.admission.encounterId;
  clinicAdmission = (await admit(clinicPatient, clinic)).admission.id;
  orderA = await addOrder(hospital, encounterA, patientA);
  orderB = await addOrder(hospital, encounterB, patientB);
});

afterAll(async () => {
  try {
    await cleanup();
    for (const table of ['stock_locations', 'drugs', 'doctors', 'patients', 'departments']) {
      await pool.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await deleteUsers(
      pool,
      [doctor, doctor2, nurse, nurse2, pharmacist, clinicNurse, closedNurse].filter(Boolean),
    );
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('the frequency of an order', () => {
  it('reads the doses a day, or none when it sets no number', () => {
    expect(dosesPerDay('1-0-1')).toBe(2);
    expect(dosesPerDay('1-1-1-1')).toBe(4);
    expect(dosesPerDay('TDS')).toBe(3);
    expect(dosesPerDay('q6h')).toBe(4);
    expect(dosesPerDay('SOS')).toBeNull();
    expect(dosesPerDay('as needed')).toBeNull();
  });
});

describe('ward vital signs', () => {
  it('records a reading with flags, audit and an event, and lists it', async () => {
    const before = await events('vitals.recorded');
    const reading = await ok<Vital>(
      await vitals(admissionA, { systolic: 190, diastolic: 100, pulse: 80 }),
      201,
    );
    expect(reading.systolic).toBe(190);
    expect(reading.flags).toMatchObject({ systolic: 'high' });
    expect(await audited('ward_vitals', reading.id)).toEqual(['create']);
    expect(await events('vitals.recorded')).toBe(before + 1);

    const list = await ok<Page<Vital>>(await get(`/admissions/${admissionA}/vitals`));
    expect(list.items.map((item) => item.id)).toContain(reading.id);
    expect(await audited('ward_vitals', reading.id)).toEqual(['create', 'read']);
  });

  it('refuses nothing to record, a pressure out of order and a future time', async () => {
    expect((await vitals(admissionA, {})).statusCode).toBe(400);
    expect((await vitals(admissionA, { systolic: 80, diastolic: 90 })).statusCode).toBe(400);
    expect((await vitals(admissionA, { systolic: 120 })).statusCode).toBe(400);
    expect(
      (
        await vitals(admissionA, {
          pulse: 70,
          observedAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    expect((await vitals(admissionA, { pulse: 700 })).statusCode).toBe(400);
  });

  it('corrects a reading once, keeping the original', async () => {
    const original = await ok<Vital>(await vitals(admissionA, { pulse: 300 }), 201);
    const correction = await ok<Vital>(
      await post(`/admissions/${admissionA}/vitals/${original.id}/correct`, {
        reason: 'Wrote the wrong digit',
        pulse: 70,
      }),
      201,
    );
    expect(correction.correctsId).toBe(original.id);
    expect(correction.observedAt).toBe(original.observedAt);
    const again = await post(`/admissions/${admissionA}/vitals/${original.id}/correct`, {
      reason: 'Again',
      pulse: 71,
    });
    expect(errorOf(again)).toEqual([422, 'already_corrected']);
    const list = await ok<Page<Vital>>(await get(`/admissions/${admissionA}/vitals?limit=100`));
    expect(list.items.find((item) => item.id === original.id)?.correctedById).toBe(correction.id);
  });

  it('answers a vital of another stay as not found', async () => {
    const reading = await ok<Vital>(await vitals(admissionB, { pulse: 66 }), 201);
    const response = await post(`/admissions/${admissionA}/vitals/${reading.id}/correct`, {
      reason: 'Wrong stay',
      pulse: 67,
    });
    expect(errorOf(response)).toEqual([404, 'vital_not_found']);
  });

  it('replays a repeated key without recording again', async () => {
    const key = fresh();
    const first = await ok<Vital>(await vitals(admissionA, { pulse: 61 }, { key }), 201);
    const rows = await count('ward_vitals');
    const replay = await vitals(admissionA, { pulse: 61 }, { key });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json<Vital>().id).toBe(first.id);
    expect(await count('ward_vitals')).toBe(rows);
  });

  it('pages with a cursor', async () => {
    const first = await ok<Page<Vital>>(await get(`/admissions/${admissionA}/vitals?limit=2`));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await ok<Page<Vital>>(
      await get(`/admissions/${admissionA}/vitals?limit=2&cursor=${first.nextCursor}`),
    );
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect((await get(`/admissions/${admissionA}/vitals?cursor=nonsense`)).statusCode).toBe(400);
  });
});

describe('the medication chart', () => {
  it('lists the stay orders and warns when nothing was dispensed', async () => {
    const orders = await ok<Page<{ id: string; dispensed: boolean; frequency: string }>>(
      await get(`/admissions/${admissionA}/mar/orders`),
    );
    expect(orders.items).toEqual([
      expect.objectContaining({ id: orderA, dispensed: false, frequency: '1-0-1' }),
    ]);
    const entry = await ok<Entry>(await given(orderA, 30), 201);
    expect(entry).toMatchObject({ outcome: 'given', doseGiven: '500 mg', route: 'oral' });
    expect(entry.warnings).toEqual(['not_dispensed']);
    expect(await audited('mar_entry', entry.id)).toEqual(['create']);
  });

  it('keeps one entry for a dose time', async () => {
    const scheduledAt = hours(40);
    await ok<Entry>(
      await recordMar({ admissionId: admissionA, orderId: orderA, scheduledAt, outcome: 'given' }),
      201,
    );
    const again = await recordMar({
      admissionId: admissionA,
      orderId: orderA,
      scheduledAt,
      outcome: 'given',
    });
    expect(errorOf(again)).toEqual([409, 'slot_recorded']);
  });

  it('needs a reason unless the dose was given, and writes nothing when refused', async () => {
    const before = await events('medication.administered');
    const rows = await count('mar_entries');
    const body = { admissionId: admissionA, orderId: orderA, scheduledAt: hours(50) };
    expect(errorOf(await recordMar({ ...body, outcome: 'withheld' }))).toEqual([
      422,
      'reason_required',
    ]);
    expect(
      (await recordMar({ ...body, outcome: 'refused', reason: 'x', doseGiven: '5' })).statusCode,
    ).toBe(400);
    expect(await count('mar_entries')).toBe(rows);
    expect(await events('medication.administered')).toBe(before);
    const withheld = await ok<Entry>(
      await recordMar({ ...body, outcome: 'withheld', reason: 'Patient is nil by mouth' }),
      201,
    );
    expect(withheld.outcome).toBe('withheld');
    expect(withheld.doseGiven).toBeUndefined();
    expect(await events('medication.administered')).toBe(before + 1);
  });

  it('refuses an order of another stay or a cancelled one', async () => {
    const other = await recordMar({
      admissionId: admissionA,
      orderId: orderB,
      scheduledAt: hours(5),
      outcome: 'given',
    });
    expect(errorOf(other)).toEqual([422, 'unknown_order']);
    const cancelled = await addOrder(hospital, encounterA, patientA);
    await pool.query(
      "update orders set status = 'cancelled', cancel_reason = 'Stopped', status_changed_at = now(), status_changed_by = $2 where id = $1",
      [cancelled, doctor.id],
    );
    expect(errorOf(await given(cancelled, 2))).toEqual([409, 'order_cancelled']);
  });

  it('needs a reason for a dose beyond the doses a day', async () => {
    const order = await addOrder(hospital, encounterB, patientB, 'BD');
    const at = (n: number) => ({
      admissionId: admissionB,
      orderId: order,
      scheduledAt: hours(n),
      outcome: 'given',
    });
    await ok<Entry>(await recordMar(at(3)), 201);
    await ok<Entry>(await recordMar(at(2)), 201);
    expect(errorOf(await recordMar(at(1)))).toEqual([422, 'extra_dose_reason_required']);
    const extra = await ok<Entry>(
      await recordMar({ ...at(1), reason: 'Fever 39.5, doctor advised' }),
      201,
    );
    expect(extra.outcome).toBe('given');
  });

  it('checks a witness', async () => {
    const body = {
      admissionId: admissionA,
      orderId: orderA,
      scheduledAt: hours(60),
      outcome: 'given',
    };
    expect(errorOf(await recordMar({ ...body, witnessId: nurse.id }))).toEqual([
      422,
      'unknown_witness',
    ]);
    expect(
      errorOf(await recordMar({ ...body, witnessId: '00000000-0000-4000-8000-000000000000' })),
    ).toEqual([422, 'unknown_witness']);
    const witnessed = await ok<Entry & { witnessId: string }>(
      await recordMar({ ...body, witnessId: nurse2.id }),
      201,
    );
    expect(witnessed.witnessId).toBe(nurse2.id);
  });

  it('corrects an entry once, keeping the slot and the original', async () => {
    const original = await ok<Entry>(await given(orderA, 70), 201);
    const corrected = await ok<Entry>(
      await post(`/mar/entries/${original.id}/correct`, {
        outcome: 'refused',
        reason: 'Patient had refused, charted by mistake',
      }),
      201,
    );
    expect(corrected).toMatchObject({ correctsId: original.id, outcome: 'refused' });
    expect(corrected.scheduledAt).toBe(original.scheduledAt);
    const again = await post(`/mar/entries/${original.id}/correct`, {
      outcome: 'given',
      reason: 'Changed again',
    });
    expect(errorOf(again)).toEqual([422, 'already_corrected']);
    const list = await ok<Page<Entry>>(
      await get(`/admissions/${admissionA}/mar?orderId=${orderA}&limit=100`),
    );
    expect(list.items.find((item) => item.id === original.id)?.correctedById).toBe(corrected.id);
    expect(
      errorOf(
        await post('/mar/entries/00000000-0000-4000-8000-000000000000/correct', {
          outcome: 'missed',
          reason: 'x',
        }),
      ),
    ).toEqual([404, 'entry_not_found']);
  });

  it('replays a repeated key and emits one event', async () => {
    const key = fresh();
    const fixedSlot = hours(80);
    const before = await events('medication.administered');
    const first = await ok<Entry>(
      await recordMar(
        {
          admissionId: admissionA,
          orderId: orderA,
          scheduledAt: fixedSlot,
          outcome: 'missed',
          reason: 'Asleep, not woken',
        },
        { key },
      ),
      201,
    );
    const replay = await recordMar(
      {
        admissionId: admissionA,
        orderId: orderA,
        scheduledAt: fixedSlot,
        outcome: 'missed',
        reason: 'Asleep, not woken',
      },
      { key },
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json<Entry>().id).toBe(first.id);
    expect(await events('medication.administered')).toBe(before + 1);
  });

  it('does not change the order', async () => {
    const { rows } = await pool.query<{ status: string }>(
      'select status from orders where id = $1',
      [orderA],
    );
    expect(rows[0]?.status).toBe('placed');
  });
});

describe('progress notes', () => {
  it('writes, edits as the author, and keeps the history', async () => {
    const key = fresh();
    const note = await ok<Note>(
      await post(
        `/admissions/${admissionA}/progress-notes`,
        { kind: 'nursing', body: 'Slept well' },
        { key },
      ),
      201,
    );
    expect(note.version).toBe(1);
    const replay = await post(
      `/admissions/${admissionA}/progress-notes`,
      { kind: 'nursing', body: 'Slept well' },
      { key },
    );
    expect(replay.json<Note>().id).toBe(note.id);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const edited = await ok<Note>(
      await send('PATCH', `/progress-notes/${note.id}`, {
        body: 'Slept well, ate breakfast',
        version: 1,
      }),
      200,
    );
    expect(edited).toMatchObject({ version: 2, body: 'Slept well, ate breakfast' });
    const history = await ok<Page<{ version: number; body: string }>>(
      await get(`/progress-notes/${note.id}/history`),
    );
    expect(history.items.map((item) => [item.version, item.body])).toEqual([
      [2, 'Slept well, ate breakfast'],
      [1, 'Slept well'],
    ]);
    expect(await audited('progress_note', note.id)).toEqual(['create', 'read', 'update', 'read']);
  });

  it('refuses a stale version and another author', async () => {
    const note = await ok<Note>(
      await post(`/admissions/${admissionA}/progress-notes`, {
        kind: 'handover',
        body: 'Handover text',
      }),
      201,
    );
    await ok<Note>(
      await send('PATCH', `/progress-notes/${note.id}`, { body: 'Changed', version: 1 }),
    );
    const stale = await send('PATCH', `/progress-notes/${note.id}`, { body: 'Late', version: 1 });
    expect(errorOf(stale)).toEqual([409, 'conflict']);
    const other = await send(
      'PATCH',
      `/progress-notes/${note.id}`,
      { body: 'Mine now', version: 2 },
      { user: nurse2 },
    );
    expect(errorOf(other)).toEqual([403, 'not_author']);
  });

  it('emits created and updated events with ids only', async () => {
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      "select payload from outbox where tenant_id = $1 and event = 'progressnote.created' limit 1",
      [hospital.id],
    );
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual([
      'admissionId',
      'encounterId',
      'kind',
      'noteId',
      'patientId',
    ]);
    expect(await events('progressnote.updated')).toBeGreaterThanOrEqual(2);
  });
});

describe('diet orders', () => {
  it('reads the diet orders of the stay and the nurse cannot place one', async () => {
    await pool.query(
      `insert into orders (tenant_id, encounter_id, patient_id, type, instructions, ordered_by)
       values ($1, $2, $3, 'diet', 'Soft diet, no salt', $4)`,
      [hospital.id, encounterA, patientA, doctor.id],
    );
    const diet = await ok<{ items: { instructions: string }[] }>(
      await get(`/admissions/${admissionA}/diet`),
    );
    expect(diet.items.map((item) => item.instructions)).toEqual(['Soft diet, no salt']);
    const placed = await post(`/encounters/${encounterA}/orders`, {
      type: 'diet',
      instructions: 'Nil by mouth',
    });
    expect(placed.statusCode).toBe(403);
  });
});

describe('ward stock requests', () => {
  it('makes an indent linked to the stay, once per key', async () => {
    const key = fresh();
    const body = {
      fromLocationId: wardPlace,
      toLocationId: store,
      lines: [{ drugId: drug, quantity: 20 }],
    };
    const request = await ok<{ id: string; indentId: string; placeId: string }>(
      await post(`/admissions/${admissionA}/stock-requests`, body, { key }),
      201,
    );
    expect(request.placeId).toBe(wardPlace);
    const { rows } = await pool.query<{ status: string; requested_by: string }>(
      'select status, requested_by from stock_indents where id = $1',
      [request.indentId],
    );
    expect(rows[0]).toEqual({ status: 'requested', requested_by: nurse.id });
    const replay = await post(`/admissions/${admissionA}/stock-requests`, body, { key });
    expect(replay.json<{ id: string }>().id).toBe(request.id);
    const indents = await pool.query('select 1 from ward_stock_requests where admission_id = $1', [
      admissionA,
    ]);
    expect(indents.rowCount).toBe(1);
    expect(await events('ward.stockrequested')).toBe(1);
    expect(
      (await post(`/admissions/${admissionA}/stock-requests`, { ...body, toLocationId: wardPlace }))
        .statusCode,
    ).toBe(400);
  });
});

describe('append-only tables', () => {
  const tables = ['ward_vitals', 'mar_entries', 'progress_note_versions', 'ward_stock_requests'];

  it.each(tables)('%s refuses UPDATE, DELETE and TRUNCATE to the owner', async (table) => {
    await expect(pool.query(`update ${table} set tenant_id = tenant_id`)).rejects.toThrow(
      /never changed|never emptied|permission/,
    );
    await expect(pool.query(`delete from ${table}`)).rejects.toThrow(/never changed/);
    await expect(pool.query(`truncate ${table}`)).rejects.toThrow(/never emptied/);
  });

  it.each([...tables, 'progress_notes'])(
    '%s gives the app role no UPDATE or DELETE of rows',
    async (table) => {
      await asTenantSql(pool, hospital.id, async (client) => {
        await client.query('savepoint a');
        await expect(client.query(`delete from ${table}`)).rejects.toThrow();
        await client.query('rollback to savepoint a');
        if (table !== 'progress_notes') {
          await expect(client.query(`update ${table} set tenant_id = tenant_id`)).rejects.toThrow();
        }
      });
    },
  );

  it('lets only the text of a progress note change', async () => {
    await expect(pool.query('delete from progress_notes')).rejects.toThrow(/never changed/);
    await expect(pool.query("update progress_notes set kind = 'handover'")).rejects.toThrow(
      /Only the text/,
    );
    await expect(pool.query('truncate progress_notes cascade')).rejects.toThrow(/never emptied/);
  });
});

describe('the hospital boundary', () => {
  const tablesWithRows = [
    'ward_vitals',
    'mar_entries',
    'progress_notes',
    'progress_note_versions',
    'ward_stock_requests',
  ];

  it.each(tablesWithRows)(
    '%s: another hospital sees and writes nothing under the app role',
    async (table) => {
      expect(await count(table)).toBeGreaterThan(0);
      await asTenantSql(pool, clinic.id, async (client) => {
        expect((await client.query(`select 1 from ${table}`)).rowCount).toBe(0);
        await client.query('savepoint a');
        await expect(
          client.query(
            `insert into ward_vitals (tenant_id, admission_id, encounter_id, patient_id, observed_at, recorded_by, pulse)
           select $1, admission_id, encounter_id, patient_id, now(), recorded_by, 70 from ward_vitals limit 1`,
            [hospital.id],
          ),
        ).resolves.toBeDefined();
        await client.query('rollback to savepoint a');
      });
    },
  );

  it('refuses to write a row of this hospital while acting for another', async () => {
    await asTenantSql(pool, clinic.id, async (client) => {
      await expect(
        client.query(
          `insert into ward_vitals (tenant_id, admission_id, encounter_id, patient_id, observed_at, recorded_by, pulse)
           values ($1, $2, $3, $4, now(), $5, 70)`,
          [hospital.id, admissionA, encounterA, patientA, nurse.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('answers a stay of another hospital as not found, in every direction', async () => {
    expect(
      errorOf(await get(`/admissions/${admissionA}/vitals`, { tenant: clinic, user: clinicNurse })),
    ).toEqual([404, 'admission_not_found']);
    expect(errorOf(await get(`/admissions/${clinicAdmission}/mar`))).toEqual([
      404,
      'admission_not_found',
    ]);
    expect(errorOf(await vitals(clinicAdmission))).toEqual([404, 'admission_not_found']);
    const note = await ok<Note>(
      await post(
        `/admissions/${clinicAdmission}/progress-notes`,
        { kind: 'nursing', body: 'Clinic note' },
        { tenant: clinic, user: clinicNurse },
      ),
      201,
    );
    expect(errorOf(await get(`/progress-notes/${note.id}/history`))).toEqual([
      404,
      'note_not_found',
    ]);
    expect(
      errorOf(
        await recordMar({
          admissionId: clinicAdmission,
          orderId: orderA,
          scheduledAt: hours(1),
          outcome: 'given',
        }),
      ),
    ).toEqual([404, 'admission_not_found']);
  });

  it('keeps a row on one patient and one stay through the foreign keys', async () => {
    await expect(
      pool.query(
        `insert into ward_vitals (tenant_id, admission_id, encounter_id, patient_id, observed_at, recorded_by, pulse)
         values ($1, $2, $3, $4, now(), $5, 70)`,
        [hospital.id, admissionA, encounterA, patientB, nurse.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query(
        `insert into ward_vitals (tenant_id, admission_id, encounter_id, patient_id, observed_at, recorded_by, pulse)
         values ($1, $2, $3, $4, now(), $5, 70)`,
        [hospital.id, admissionA, encounterB, patientA, nurse.id],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^23503|23514$/) });
    await expect(
      pool.query(
        `insert into mar_entries (tenant_id, admission_id, encounter_id, patient_id, order_id, drug_id, scheduled_at, outcome, administered_at, dose_given, route, recorded_by)
         values ($1, $2, $3, $4, $5, $6, now(), 'given', now(), '1', 'oral', $7)`,
        [hospital.id, admissionA, encounterA, patientA, orderB, drug, nurse.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('scope and permissions', () => {
  it('refuses a role without the permission and a hospital with nursing off', async () => {
    expect(errorOf(await get(`/admissions/${admissionA}/vitals`, { user: pharmacist }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      errorOf(await get(`/admissions/${admissionA}/vitals`, { tenant: closed, user: closedNurse })),
    ).toEqual([403, 'feature_disabled']);
  });

  it('lets a doctor read but not record', async () => {
    expect((await get(`/admissions/${admissionA}/vitals`, { user: doctor })).statusCode).toBe(200);
    expect((await get(`/admissions/${admissionA}/mar`, { user: doctor })).statusCode).toBe(200);
    expect(errorOf(await vitals(admissionA, { pulse: 70 }, { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      errorOf(
        await recordMar(
          { admissionId: admissionA, orderId: orderA, scheduledAt: hours(4), outcome: 'given' },
          { user: doctor },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
  });

  it('narrows to own or department by the stay admitting doctor', async () => {
    const setScope = (user: string, scope: string) =>
      pool.query(
        "update role_permissions set scope = $3 where tenant_id = $1 and role_id = $2 and permission = 'nursingVitals:read'",
        [hospital.id, user, scope],
      );
    try {
      await setScope('doctor', 'own');
      expect((await get(`/admissions/${admissionA}/vitals`, { user: doctor })).statusCode).toBe(
        200,
      );
      expect(errorOf(await get(`/admissions/${admissionA}/vitals`, { user: doctor2 }))).toEqual([
        404,
        'admission_not_found',
      ]);
      await setScope('doctor', 'department');
      expect((await get(`/admissions/${admissionA}/vitals`, { user: doctor2 })).statusCode).toBe(
        200,
      );
      await setScope('nurse', 'own');
      expect(errorOf(await get(`/admissions/${admissionA}/vitals`))).toEqual([
        404,
        'admission_not_found',
      ]);
    } finally {
      await setScope('doctor', 'all');
      await setScope('nurse', 'all');
    }
  });
});

describe('review fixes', () => {
  it('bounds the time a dose is due', async () => {
    const before = await recordMar({
      admissionId: admissionA,
      orderId: orderA,
      scheduledAt: hours(500),
      outcome: 'given',
    });
    expect(errorOf(before)).toEqual([422, 'slot_out_of_window']);
    const ahead = await recordMar({
      admissionId: admissionA,
      orderId: orderA,
      scheduledAt: hours(-48),
      outcome: 'missed',
      reason: 'Too far ahead',
    });
    expect(errorOf(ahead)).toEqual([422, 'slot_out_of_window']);
  });

  it('keeps one of two entries made at once for the same dose', async () => {
    const body = {
      admissionId: admissionA,
      orderId: orderA,
      scheduledAt: hours(120),
      outcome: 'given',
    };
    const [one, two] = await Promise.all([recordMar(body), recordMar(body)]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
    expect(errorOf(one.statusCode === 409 ? one : two)).toEqual([409, 'slot_recorded']);
  });

  it('answers a correction outside the scope as an entry not found', async () => {
    const entry = await ok<Entry>(await given(orderA, 130), 201);
    const setScope = (scope: string) =>
      pool.query(
        "update role_permissions set scope = $2 where tenant_id = $1 and role_id = 'nurse' and permission = 'mar:record'",
        [hospital.id, scope],
      );
    try {
      await setScope('own');
      const response = await post(`/mar/entries/${entry.id}/correct`, {
        outcome: 'missed',
        reason: 'Not mine',
      });
      expect(errorOf(response)).toEqual([404, 'entry_not_found']);
    } finally {
      await setScope('all');
    }
  });

  it('checks the clinical and inventory modules, also on a repeated key', async () => {
    const setFlag = (feature: string, enabled: boolean) =>
      pool.query('update tenant_features set enabled = $3 where tenant_id = $1 and feature = $2', [
        hospital.id,
        feature,
        enabled,
      ]);
    const markKey = fresh();
    const stockKey = fresh();
    const mark = {
      admissionId: admissionA,
      orderId: orderA,
      scheduledAt: hours(140),
      outcome: 'given',
    };
    const stock = {
      fromLocationId: wardPlace,
      toLocationId: store,
      lines: [{ drugId: drug, quantity: 2 }],
    };
    await ok(await recordMar(mark, { key: markKey }), 201);
    await ok(await post(`/admissions/${admissionA}/stock-requests`, stock, { key: stockKey }), 201);
    const requestId = (
      await pool.query<{ id: string }>(
        'select id from ward_stock_requests order by requested_at desc limit 1',
      )
    ).rows[0]?.id;
    try {
      await setFlag('clinical', false);
      expect(errorOf(await recordMar(mark, { key: markKey }))).toEqual([403, 'feature_disabled']);
      expect(errorOf(await recordMar({ ...mark, scheduledAt: hours(141) }))).toEqual([
        403,
        'feature_disabled',
      ]);
      expect(errorOf(await get(`/admissions/${admissionA}/diet`))).toEqual([
        403,
        'feature_disabled',
      ]);
      expect(errorOf(await get(`/admissions/${admissionA}/mar/orders`))).toEqual([
        403,
        'feature_disabled',
      ]);
      await setFlag('clinical', true);
      await setFlag('inventory', false);
      expect(
        errorOf(await post(`/admissions/${admissionA}/stock-requests`, stock, { key: stockKey })),
      ).toEqual([403, 'feature_disabled']);
      expect(errorOf(await post(`/admissions/${admissionA}/stock-requests`, stock))).toEqual([
        403,
        'feature_disabled',
      ]);
    } finally {
      await setFlag('clinical', true);
      await setFlag('inventory', true);
    }
    const replay = await post(`/admissions/${admissionA}/stock-requests`, stock, { key: stockKey });
    expect(replay.statusCode).toBe(201);
    expect(replay.json<{ id: string }>().id).toBe(requestId);
    expect(await audited('ward_stock_request', requestId ?? '')).toContain('read');
  });

  it('refuses a stock request without indent:create', async () => {
    const response = await post(
      `/admissions/${admissionA}/stock-requests`,
      { fromLocationId: wardPlace, toLocationId: store, lines: [{ drugId: drug, quantity: 1 }] },
      { user: doctor },
    );
    expect(errorOf(response)).toEqual([403, 'permission_denied']);
  });

  it('keeps every new table out of reach of another hospital', async () => {
    const stay = [admissionA, encounterA, patientA];
    const inserts: Record<string, [string, unknown[]]> = {
      ward_vitals: [
        'insert into ward_vitals (tenant_id, admission_id, encounter_id, patient_id, observed_at, recorded_by, pulse) values ($1, $2, $3, $4, now(), $5, 70)',
        [hospital.id, ...stay, nurse.id],
      ],
      mar_entries: [
        "insert into mar_entries (tenant_id, admission_id, encounter_id, patient_id, order_id, drug_id, scheduled_at, outcome, reason, recorded_by) values ($1, $2, $3, $4, $5, $6, now(), 'missed', 'x', $7)",
        [hospital.id, ...stay, orderA, drug, nurse.id],
      ],
      progress_notes: [
        "insert into progress_notes (tenant_id, admission_id, encounter_id, patient_id, kind, body, created_by, updated_by) values ($1, $2, $3, $4, 'nursing', 'x', $5, $5)",
        [hospital.id, ...stay, nurse.id],
      ],
      progress_note_versions: [
        "insert into progress_note_versions (tenant_id, note_id, version, body, edited_by) select tenant_id, id, 99, 'x', $2 from progress_notes where tenant_id = $1 limit 1",
        [hospital.id, nurse.id],
      ],
      ward_stock_requests: [
        'insert into ward_stock_requests (tenant_id, indent_id, admission_id, encounter_id, patient_id, place_id, requested_by) values ($1, gen_random_uuid(), $2, $3, $4, $5, $6)',
        [hospital.id, ...stay, wardPlace, nurse.id],
      ],
    };
    for (const [table, [sql, params]] of Object.entries(inserts)) {
      await asTenantSql(pool, clinic.id, async (client) => {
        await client.query('savepoint a');
        const written = await client.query(sql, params).then(
          (result) => result.rowCount,
          () => 0,
        );
        expect(written, table).toBe(0);
        await client.query('rollback to savepoint a');
        expect(
          (await client.query(`select 1 from ${table} where tenant_id = $1`, [hospital.id]))
            .rowCount,
          table,
        ).toBe(0);
      });
    }
    await asTenantSql(pool, clinic.id, async (client) => {
      expect(
        (
          await client.query("update progress_notes set body = 'x' where tenant_id = $1", [
            hospital.id,
          ])
        ).rowCount,
      ).toBe(0);
    });
  });
});

describe('a stay that has ended', () => {
  it('takes no new record, from the code or from the database', async () => {
    const stay = await ok<{ admission: { version: number } }>(
      await get(`/admissions/${admissionB}`, { user: doctor }),
    );
    await ok(
      await post(
        `/admissions/${admissionB}/discharge`,
        { dischargeType: 'routine', version: stay.admission.version },
        { user: doctor },
      ),
    );
    const refused = [
      await vitals(admissionB),
      await recordMar({
        admissionId: admissionB,
        orderId: orderB,
        scheduledAt: hours(9),
        outcome: 'given',
      }),
      await post(`/admissions/${admissionB}/progress-notes`, {
        kind: 'nursing',
        body: 'Late note',
      }),
      await post(`/admissions/${admissionB}/stock-requests`, {
        fromLocationId: wardPlace,
        toLocationId: store,
        lines: [{ drugId: drug, quantity: 1 }],
      }),
    ];
    expect(refused.map(errorOf)).toEqual(Array(4).fill([409, 'admission_not_open']));
    await expect(
      pool.query(
        `insert into ward_vitals (tenant_id, admission_id, encounter_id, patient_id, observed_at, recorded_by, pulse)
         values ($1, $2, $3, $4, now(), $5, 70)`,
        [hospital.id, admissionB, encounterB, patientB, nurse.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The history stays readable.
    expect((await get(`/admissions/${admissionB}/vitals`)).statusCode).toBe(200);
  });
});
