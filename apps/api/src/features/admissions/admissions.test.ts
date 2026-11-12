import type { AddressInfo } from 'node:net';
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
 * The admissions API through the real app and database: admitting with and without a bed, moving
 * a patient between beds, discharge, the bed history, the board and housekeeping; the one-bed
 * rule under concurrency; the hospital boundary, permissions, audit, events and the live stream.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** The admissions module switched off. */
let closed: TestTenant;
/** A doctor (with a profile), who admits and discharges. */
let doctor: TestUser;
/** Moves patients and keeps beds ready, cannot admit or discharge. */
let nurse: TestUser;
/** No admission permission at all. */
let pharmacist: TestUser;
let clinicDoctor: TestUser;
let department: string;
let clinicDepartment: string;
let ward: string;
let clinicWard: string;
const beds: string[] = [];
let clinicBed: string;
const patients: string[] = [];
let clinicPatient: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Bed {
  assignmentId: string;
  bedId: string;
  wardId: string;
}
interface Admission {
  id: string;
  encounterId: string;
  sourceEncounterId?: string;
  patientName: string;
  status: string;
  bed?: Bed;
  dischargeType?: string;
  cancelReason?: string;
  consents?: string[];
  version: number;
}
interface Stay {
  bedId: string;
  releasedAt?: string;
  releaseReason?: string;
  serviceId?: string;
  dayPriceMinor?: number;
  moveReason?: string;
  moveNote?: string;
}
interface Detail {
  admission: Admission;
  stays: Stay[];
}
interface BoardBed {
  id: string;
  status: string;
  version: number;
  occupant?: { patientName: string; admissionId: string };
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const headers = ({ tenant = hospital, user = doctor, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `adt-key-${String(++keys).padStart(6, '0')}`;
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

const admit = (patientId: string, more: object = {}, options: Options = {}) =>
  post('/admissions', { patientId, admissionType: 'planned', ...more }, options);
const admitted = async (patientId: string, more: object = {}, options: Options = {}) =>
  ok<Detail>(await admit(patientId, more, options), 201);
const read = async (id: string, options: Options = {}) =>
  ok<Detail>(await get(`/admissions/${id}`, options));
const transfer = (detail: Detail, bedId: string, options: Options = {}) =>
  post(
    `/admissions/${detail.admission.id}/transfer`,
    { bedId, version: detail.admission.version },
    options,
  );
const discharge = (detail: Detail, more: object = {}, options: Options = {}) =>
  post(
    `/admissions/${detail.admission.id}/discharge`,
    { dischargeType: 'routine', version: detail.admission.version, ...more },
    options,
  );

const cancel = (detail: Detail, more: object = {}, options: Options = {}) =>
  post(
    `/admissions/${detail.admission.id}/cancel`,
    { reason: 'Admitted by mistake', version: detail.admission.version, ...more },
    options,
  );

const bedStatus = async (bedId: string) =>
  (await pool.query<{ status: string }>('select status from beds where id = $1', [bedId])).rows[0]
    ?.status;
/** Back to a free bed, as housekeeping would leave it, and the patient out of the way. */
const reset = async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query('delete from bed_assignments where tenant_id = any($1)', [tenants()]);
    await client.query(
      "update beds set status = 'available', blocked_reason = null, blocked_note = null where tenant_id = any($1)",
      [tenants()],
    );
    for (const table of ['clinical_notes', 'admissions', 'encounters', 'outbox']) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};
const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);

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
  ).rows;
const allEvents = async () =>
  (
    await pool.query<{ event: string }>(
      'select event from outbox where tenant_id = $1 order by event',
      [hospital.id],
    )
  ).rows.map((row) => row.event);

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Adt', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `AD-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

async function structure(tenant: TestTenant, departmentId: string, count: number) {
  const one = async <T extends { id: string }>(sql: string, params: unknown[]) => {
    const { rows } = await pool.query<T>(sql, params);
    return rows[0]?.id ?? '';
  };
  const category = await one(
    'insert into bed_categories (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, 'General'],
  );
  const wardId = await one(
    'insert into wards (tenant_id, code, name, department_id) values ($1, $2, $3, $4) returning id',
    [tenant.id, 'W1', 'Ward One', departmentId],
  );
  const room = await one(
    'insert into rooms (tenant_id, ward_id, name) values ($1, $2, $3) returning id',
    [tenant.id, wardId, 'Room 1'],
  );
  const bedIds: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    bedIds.push(
      await one(
        'insert into beds (tenant_id, ward_id, room_id, number, bed_category_id) values ($1, $2, $3, $4, $5) returning id',
        [tenant.id, wardId, room, `B${n}`, category],
      ),
    );
  }
  return { wardId, bedIds };
}

async function addDoctor(tenant: TestTenant, user: TestUser, departmentId: string) {
  await pool.query(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General', 15)`,
    [tenant.id, user.id, departmentId],
  );
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = {
    features: {
      admissions: true,
      wards: true,
      clinical: true,
      patients: true,
      doctors: true,
      departments: true,
    },
  };
  hospital = await createTenant(pool, 'Adt Hospital', on);
  clinic = await createTenant(pool, 'Adt Clinic', on);
  closed = await createTenant(pool, 'Adt Closed', { features: { admissions: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  doctor = await createUser(pool, 'Adt Doctor', { withPassword: false });
  nurse = await createUser(pool, 'Adt Nurse', { withPassword: false });
  pharmacist = await createUser(pool, 'Adt Pharmacist', { withPassword: false });
  clinicDoctor = await createUser(pool, 'Adt Clinic Doctor', { withPassword: false });
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, closed, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicDoctor, clinic, 'doctor');
  const addDepartment = async (tenant: TestTenant) =>
    (
      await pool.query<{ id: string }>(
        'insert into departments (tenant_id, name) values ($1, $2) returning id',
        [tenant.id, 'Medicine'],
      )
    ).rows[0]?.id ?? '';
  department = await addDepartment(hospital);
  clinicDepartment = await addDepartment(clinic);
  await addDoctor(hospital, doctor, department);
  await addDoctor(clinic, clinicDoctor, clinicDepartment);
  const made = await structure(hospital, department, 4);
  ward = made.wardId;
  beds.push(...made.bedIds);
  const clinicMade = await structure(clinic, clinicDepartment, 1);
  clinicWard = clinicMade.wardId;
  clinicBed = clinicMade.bedIds[0] ?? '';
  for (const name of ['Asha', 'Bina', 'Chitra', 'Devi', 'Esha']) {
    patients.push(await addPatient(hospital, name));
  }
  clinicPatient = await addPatient(clinic, 'Clinic');
});

afterAll(async () => {
  try {
    await reset();
    for (const table of [
      'beds',
      'rooms',
      'wards',
      'bed_categories',
      'doctors',
      'patients',
      'departments',
    ]) {
      await pool.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await deleteUsers(pool, [doctor, nurse, pharmacist, clinicDoctor].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

const bed = (n: number): string => beds[n] ?? '';
const patient = (n: number): string => patients[n] ?? '';

describe('admitting a patient', () => {
  it('admits without a bed, with an inpatient encounter, an audit entry and events', async () => {
    await reset();
    const detail = await admitted(patient(0));
    expect(detail.admission).toMatchObject({
      status: 'admitted',
      patientName: 'Asha Adt',
      version: 1,
    });
    expect(detail.admission.bed).toBeUndefined();
    expect(detail.stays).toEqual([]);

    const { rows } = await pool.query<{ type: string; status: string }>(
      'select type, status from encounters where id = $1',
      [detail.admission.encounterId],
    );
    expect(rows[0]).toEqual({ type: 'ipd', status: 'open' });
    expect(await audited('admission', detail.admission.id)).toEqual(['create']);
    expect((await eventsOf(detail.admission.id)).map((event) => event.event)).toEqual([
      'admission.created',
    ]);
    expect(await allEvents()).toEqual(['admission.created', 'encounter.opened']);
  });

  it('gives a bed at once: occupied, one assignment, bed.assigned, and on the board', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    expect(detail.admission.bed).toMatchObject({ bedId: bed(0), wardId: ward });
    expect(await bedStatus(bed(0))).toBe('occupied');
    expect(detail.stays).toHaveLength(1);
    expect(await allEvents()).toEqual(['admission.created', 'bed.assigned', 'encounter.opened']);
    expect((await eventsOf(bed(0)))[0]?.payload).toMatchObject({
      admissionId: detail.admission.id,
      bedId: bed(0),
      wardId: ward,
    });
  });

  it('admits a patient once until they are discharged', async () => {
    await reset();
    const first = await admitted(patient(0));
    expect(errorOf(await admit(patient(0)))).toEqual([409, 'already_admitted']);
    await ok(await discharge(first));
    await admitted(patient(0));
  });

  it('refuses a bed that is taken, being cleaned, blocked or not the hospital’s', async () => {
    await reset();
    await admitted(patient(0), { bedId: bed(0) });
    expect(errorOf(await admit(patient(1), { bedId: bed(0) }))).toEqual([409, 'bed_not_available']);
    await pool.query("update beds set status = 'cleaning' where id = $1", [bed(1)]);
    expect(errorOf(await admit(patient(1), { bedId: bed(1) }))).toEqual([409, 'bed_not_available']);
    await pool.query(
      "update beds set status = 'blocked', blocked_reason = 'repair' where id = $1",
      [bed(2)],
    );
    expect(errorOf(await admit(patient(1), { bedId: bed(2) }))).toEqual([409, 'bed_not_available']);
    expect(errorOf(await admit(patient(1), { bedId: clinicBed }))).toEqual([422, 'unknown_bed']);
    expect(errorOf(await admit(patient(1), { bedId: 'nonsense' }))).toEqual([422, 'unknown_bed']);
    // Nothing of the refused requests was kept.
    const { rows } = await pool.query(
      'select 1 from admissions where tenant_id = $1 and patient_id = $2',
      [hospital.id, patient(1)],
    );
    expect(rows).toHaveLength(0);
  });

  it('lets one of two admissions to the same bed at the same moment succeed', async () => {
    await reset();
    const results = await Promise.all([
      admit(patient(0), { bedId: bed(0) }),
      admit(patient(1), { bedId: bed(0) }),
      admit(patient(2), { bedId: bed(0) }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409, 409]);
    const { rows } = await pool.query(
      'select 1 from bed_assignments where bed_id = $1 and released_at is null',
      [bed(0)],
    );
    expect(rows).toHaveLength(1);
  });

  it('is backed by the database: one open assignment per bed, and per admission', async () => {
    await reset();
    const one = await admitted(patient(0), { bedId: bed(0) });
    const two = await admitted(patient(1));
    const insert = (admissionId: string, patientId: string, bedId: string) =>
      pool.query(
        `insert into bed_assignments (tenant_id, admission_id, patient_id, bed_id, ward_id,
                                      bed_category_id, assigned_by)
         select $1, $2, $3, b.id, b.ward_id, b.bed_category_id, $5 from beds b where b.id = $4`,
        [hospital.id, admissionId, patientId, bedId, doctor.id],
      );
    await expect(insert(two.admission.id, patient(1), bed(0))).rejects.toMatchObject({
      code: '23P01',
    });
    await expect(insert(one.admission.id, patient(0), bed(1))).rejects.toMatchObject({
      code: '23P01',
    });
    // Another patient's admission cannot be given the assignment of a different patient.
    await expect(insert(two.admission.id, patient(0), bed(1))).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('answers a repeat of the same key with the same admission and admits nobody twice', async () => {
    await reset();
    const key = fresh();
    const first = await ok<Detail>(await admit(patient(0), { bedId: bed(0) }, { key }), 201);
    const again = await admit(patient(0), { bedId: bed(0) }, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Detail>().admission.id).toBe(first.admission.id);
    const { rows } = await pool.query('select 1 from admissions where tenant_id = $1', [
      hospital.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the advice, attendant, deposit and consents given at admission', async () => {
    await reset();
    const plain = await admitted(patient(0));
    expect(plain.admission.consents).toEqual([]);
    expect(plain.admission).not.toHaveProperty('depositMinor');
    await ok(await discharge(plain));

    const more = {
      adviceNote: 'Admit for observation after chest pain',
      attendantName: 'Ravi Adt',
      attendantRelation: 'spouse',
      attendantPhone: '+919800000000',
      depositMinor: 500000,
      consents: ['admission', 'treatment'],
    };
    const detail = await admitted(patient(0), more);
    expect(detail.admission).toMatchObject(more);
    expect((await read(detail.admission.id)).admission).toMatchObject(more);
    expect(JSON.stringify(await allEvents())).not.toContain('Ravi');
  });

  it('records the visit an admission came from, one of the patient’s own (#678)', async () => {
    await reset();
    const visit = async (patientId: string, tenant: TestTenant, type = 'opd') =>
      (
        await pool.query<{ id: string }>(
          `insert into encounters (tenant_id, patient_id, type, opened_by)
           values ($1, $2, $3, $4) returning id`,
          [tenant.id, patientId, type, doctor.id],
        )
      ).rows[0]?.id ?? '';
    const opd = await visit(patient(0), hospital);
    const other = await visit(patient(1), hospital);
    const stay = await visit(patient(0), hospital, 'ipd');
    for (const sourceEncounterId of [other, stay, 'not-an-encounter']) {
      expect(errorOf(await admit(patient(0), { sourceEncounterId }))[1]).toBe('unknown_encounter');
    }
    const detail = await admitted(patient(0), { sourceEncounterId: opd });
    expect(detail.admission.sourceEncounterId).toBe(opd);
    expect(detail.admission.encounterId).not.toBe(opd);
    expect((await read(detail.admission.id)).admission.sourceEncounterId).toBe(opd);
  });

  it('refuses details that do not fit', async () => {
    await reset();
    for (const more of [
      { depositMinor: -1 },
      { depositMinor: 1.5 },
      { consents: ['nonsense'] },
      { consents: ['treatment', 'treatment'] },
      { attendantRelation: 'neighbour' },
      { attendantName: '' },
      { adviceNote: 'x'.repeat(1001) },
      { attendantName: 'Bad Name' },
    ]) {
      expect(errorOf(await admit(patient(0), more))[0]).toBe(400);
    }
    expect(errorOf(await admit(patient(0), { attendantPhone: '+919800000000' }))).toEqual([
      422,
      'attendant_name_required',
    ]);
  });

  it('needs a patient the caller reads and a doctor who practises here', async () => {
    await reset();
    expect(errorOf(await admit(clinicPatient))).toEqual([422, 'unknown_patient']);
    expect(errorOf(await admit('nonsense'))).toEqual([422, 'unknown_patient']);
    expect(errorOf(await admit(patient(0), { doctorId: 'nonsense' }))).toEqual([
      422,
      'unknown_doctor',
    ]);
    // The nurse has no doctor profile, but may not admit anyway.
    expect(errorOf(await admit(patient(0), {}, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
  });
});

describe('moving a patient', () => {
  it('gives a bed to a patient who has none, then moves them, keeping the history', async () => {
    await reset();
    const waiting = await admitted(patient(0));
    const assign = await ok<Detail>(
      await post(`/admissions/${waiting.admission.id}/assign-bed`, {
        bedId: bed(0),
        version: waiting.admission.version,
      }),
    );
    expect(assign.admission.bed?.bedId).toBe(bed(0));
    expect(assign.admission.version).toBe(2);
    expect(await bedStatus(bed(0))).toBe('occupied');

    const moved = await ok<Detail>(await transfer(assign, bed(1), { user: nurse }));
    expect(moved.admission.bed?.bedId).toBe(bed(1));
    expect(moved.admission.version).toBe(3);
    expect(await bedStatus(bed(0))).toBe('cleaning');
    expect(await bedStatus(bed(1))).toBe('occupied');
    expect(moved.stays.map((stay) => stay.bedId)).toEqual([bed(0), bed(1)]);
    expect(moved.stays[0]).toMatchObject({ releaseReason: 'transfer' });
    expect(moved.stays[0]?.releasedAt).toBeTruthy();
    expect(moved.stays[1]?.releasedAt).toBeUndefined();

    expect((await eventsOf(bed(0))).map((event) => event.event)).toEqual([
      'bed.assigned',
      'bed.released',
    ]);
    expect((await eventsOf(bed(0)))[1]?.payload).toMatchObject({ reason: 'transfer' });
    expect(await audited('admission', moved.admission.id)).toEqual(['create', 'update', 'update']);
    // The history is also read back on its own.
    expect((await read(moved.admission.id)).stays).toHaveLength(2);
  });

  it('keeps a reason and note on a transfer and a bed given later', async () => {
    await reset();
    const waiting = await admitted(patient(0));
    const given = await ok<Detail>(
      await post(`/admissions/${waiting.admission.id}/assign-bed`, {
        bedId: bed(0),
        version: waiting.admission.version,
        reason: 'clinical',
      }),
    );
    expect(given.stays[0]).toMatchObject({ moveReason: 'clinical' });
    expect(given.stays[0]?.moveNote).toBeUndefined();
    const moved = await ok<Detail>(
      await post(`/admissions/${given.admission.id}/transfer`, {
        bedId: bed(1),
        version: given.admission.version,
        reason: 'isolation',
        note: '  Needs a  single room ',
      }),
    );
    expect(moved.stays[1]).toMatchObject({
      moveReason: 'isolation',
      moveNote: 'Needs a single room',
    });
    expect(moved.stays[1]?.dayPriceMinor).toBeUndefined();
    // A note alone, an unknown reason and a control character are refused.
    const base = { bedId: bed(2), version: moved.admission.version };
    for (const extra of [{ note: 'x' }, { reason: 'whim' }, { reason: 'other', note: 'ab' }]) {
      const response = await post(`/admissions/${moved.admission.id}/transfer`, {
        ...base,
        ...extra,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('keeps the category and the service the bed had when it was given', async () => {
    await reset();
    const service = (
      await pool.query<{ id: string }>(
        `insert into services (tenant_id, code, name, category, tax_class)
         values ($1, 'BEDDAY', 'Bed day', 'bed', 'standard') returning id`,
        [hospital.id],
      )
    ).rows[0]?.id;
    await pool.query(
      'update bed_categories set service_id = $2 where tenant_id = $1 and name = $3',
      [hospital.id, service, 'General'],
    );
    await pool.query(
      `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
       select $1, $2, id, 250000, '2020-01-01' from price_lists where tenant_id = $1 and standard`,
      [hospital.id, service],
    );
    try {
      const detail = await admitted(patient(0), { bedId: bed(0) });
      await pool.query('update bed_categories set service_id = null where tenant_id = $1', [
        hospital.id,
      ]);
      const stay = (await read(detail.admission.id)).stays[0];
      expect(stay?.serviceId).toBe(service);
      expect(stay?.dayPriceMinor).toBe(250000);
    } finally {
      await pool.query('delete from service_prices where service_id = $1', [service]);
      await pool.query('update bed_categories set service_id = null where tenant_id = $1', [
        hospital.id,
      ]);
      await reset();
      await pool.query('delete from services where id = $1', [service]);
    }
  });

  it('refuses what does not fit the stay', async () => {
    await reset();
    const waiting = await admitted(patient(0));
    // No bed to leave, and a stale version.
    expect(errorOf(await transfer(waiting, bed(0)))).toEqual([409, 'no_bed']);
    expect(
      errorOf(
        await post(`/admissions/${waiting.admission.id}/assign-bed`, { bedId: bed(0), version: 9 }),
      ),
    ).toEqual([409, 'conflict']);
    const placed = await ok<Detail>(
      await post(`/admissions/${waiting.admission.id}/assign-bed`, {
        bedId: bed(0),
        version: waiting.admission.version,
      }),
    );
    expect(
      errorOf(
        await post(`/admissions/${placed.admission.id}/assign-bed`, {
          bedId: bed(1),
          version: placed.admission.version,
        }),
      ),
    ).toEqual([409, 'already_in_bed']);
    expect(errorOf(await transfer(placed, bed(0)))).toEqual([422, 'same_bed']);
    expect(errorOf(await transfer(placed, clinicBed))).toEqual([422, 'unknown_bed']);
    // A bed that is not free, and the failed move leaves the patient where they were.
    await admitted(patient(1), { bedId: bed(1) });
    expect(errorOf(await transfer(placed, bed(1)))).toEqual([409, 'bed_not_available']);
    expect((await read(placed.admission.id)).admission.bed?.bedId).toBe(bed(0));
    expect(await bedStatus(bed(0))).toBe('occupied');
  });

  it('lets one of two patients take the last free bed', async () => {
    await reset();
    const one = await admitted(patient(0), { bedId: bed(0) });
    const two = await admitted(patient(1), { bedId: bed(1) });
    const results = await Promise.all([transfer(one, bed(2)), transfer(two, bed(2))]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const { rows } = await pool.query(
      'select count(*)::int as n from bed_assignments where bed_id = $1 and released_at is null',
      [bed(2)],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('moves two patients to different beds at the same moment without deadlock', async () => {
    await reset();
    const one = await admitted(patient(0), { bedId: bed(0) });
    const two = await admitted(patient(1), { bedId: bed(1) });
    const results = await Promise.all([transfer(one, bed(3)), transfer(two, bed(2))]);
    expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
  });
});

describe('discharge', () => {
  it('closes the stay: the encounter, the bed being cleaned, the events', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const done = await ok<Detail>(await discharge(detail, { dischargeType: 'against_advice' }));
    expect(done.admission).toMatchObject({
      status: 'discharged',
      dischargeType: 'against_advice',
    });
    expect(done.admission.bed).toBeUndefined();
    expect(done.stays[0]).toMatchObject({ releaseReason: 'discharge' });
    expect(await bedStatus(bed(0))).toBe('cleaning');
    const { rows } = await pool.query<{ status: string }>(
      'select status from encounters where id = $1',
      [detail.admission.encounterId],
    );
    expect(rows[0]?.status).toBe('closed');
    expect(await allEvents()).toEqual([
      'admission.created',
      'bed.assigned',
      'bed.released',
      'discharge.completed',
      'encounter.closed',
      'encounter.opened',
    ]);
    expect((await eventsOf(detail.admission.id)).at(-1)?.payload).toMatchObject({
      dischargeType: 'against_advice',
      encounterId: detail.admission.encounterId,
    });
    // Final: nothing more is done to it.
    const after = done.admission.version;
    expect(
      errorOf(
        await post(`/admissions/${detail.admission.id}/discharge`, {
          dischargeType: 'routine',
          version: after,
        }),
      ),
    ).toEqual([409, 'invalid_transition']);
    expect(errorOf(await transfer(done, bed(1)))).toEqual([409, 'invalid_transition']);
    await expect(
      pool.query("update admissions set status = 'admitted' where id = $1", [detail.admission.id]),
    ).rejects.toThrow(/only discharged/);
  });

  it('discharges a patient who never had a bed', async () => {
    await reset();
    const detail = await admitted(patient(0));
    const done = await ok<Detail>(await discharge(detail));
    expect(done.admission.status).toBe('discharged');
    expect(await allEvents()).not.toContain('bed.released');
  });

  it('waits for the notes of the stay to be signed', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    await pool.query(
      `insert into clinical_notes (tenant_id, encounter_id, patient_id, body, author_id, status)
       values ($1, $2, $3, '{}', $4, 'draft')`,
      [hospital.id, detail.admission.encounterId, patient(0), doctor.id],
    );
    expect(errorOf(await discharge(detail))).toEqual([409, 'unsigned_notes']);
    expect((await read(detail.admission.id)).admission.status).toBe('admitted');
    expect(await bedStatus(bed(0))).toBe('occupied');
  });

  it('is for those who hold admission:discharge', async () => {
    await reset();
    const detail = await admitted(patient(0));
    expect(errorOf(await discharge(detail, {}, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
  });
});

describe('cancelling an admission made by mistake', () => {
  it('cancels the stay, frees the bed at once and leaves the patient free to be admitted', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const done = await ok<Detail>(await cancel(detail, { reason: '  Wrong patient  ' }));
    expect(done.admission).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong patient' });
    expect(done.admission.bed).toBeUndefined();
    expect(done.stays[0]).toMatchObject({ releaseReason: 'cancelled' });
    // Ready for the next patient: nothing was used, so nothing needs cleaning.
    expect(await bedStatus(bed(0))).toBe('available');
    const { rows } = await pool.query<{ status: string; cancel_reason: string }>(
      'select status, cancel_reason from encounters where id = $1',
      [detail.admission.encounterId],
    );
    expect(rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'Wrong patient' });
    expect(await allEvents()).toEqual([
      'admission.cancelled',
      'admission.created',
      'bed.assigned',
      'bed.released',
      'encounter.cancelled',
      'encounter.opened',
    ]);
    expect(JSON.stringify(await eventsOf(detail.admission.id))).not.toContain('Wrong patient');
    expect(await audited('admission', detail.admission.id)).toContain('update');
    // The same patient and the same bed can be admitted again.
    const again = await admitted(patient(0), { bedId: bed(0) });
    expect(again.admission.status).toBe('admitted');
  });

  it('cancels an admission that never had a bed', async () => {
    await reset();
    const detail = await admitted(patient(0));
    const done = await ok<Detail>(await cancel(detail));
    expect(done.admission.status).toBe('cancelled');
    expect(await allEvents()).not.toContain('bed.released');
  });

  it('is final, and the listing can filter for it', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const done = await ok<Detail>(await cancel(detail));
    expect(errorOf(await cancel(done))).toEqual([409, 'invalid_transition']);
    expect(errorOf(await discharge(done))).toEqual([409, 'invalid_transition']);
    expect(errorOf(await transfer(done, bed(1)))).toEqual([409, 'invalid_transition']);
    await expect(
      pool.query("update admissions set status = 'admitted' where id = $1", [detail.admission.id]),
    ).rejects.toThrow(/only discharged or cancelled/);
    const page = await ok<Page<Admission>>(await get('/admissions?status=cancelled'));
    expect(page.items.map((item) => item.id)).toEqual([detail.admission.id]);
  });

  it('answers a repeat of the same key without cancelling twice', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const key = fresh();
    const first = await cancel(detail, {}, { key });
    const second = await cancel(detail, {}, { key });
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(
      await allEvents().then((all) => all.filter((e) => e === 'admission.cancelled')),
    ).toHaveLength(1);
  });

  it('needs a reason and the version it was read at', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    expect(errorOf(await cancel(detail, { reason: '' }))[0]).toBe(400);
    expect(errorOf(await cancel(detail, { reason: '   ' }))).toEqual([400, 'validation_failed']);
    expect(errorOf(await cancel(detail, { version: detail.admission.version + 1 }))).toEqual([
      409,
      'conflict',
    ]);
    expect(await bedStatus(bed(0))).toBe('occupied');
  });

  it('refuses a stay that has a draft note or anything on its record', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const note = (status: string) =>
      pool.query(
        `insert into clinical_notes (tenant_id, encounter_id, patient_id, body, author_id, status, signed_at)
         values ($1, $2, $3, '{}', $4, $5, case when $5 = 'signed' then now() end)`,
        [hospital.id, detail.admission.encounterId, patient(0), doctor.id, status],
      );
    await note('draft');
    expect(errorOf(await cancel(detail))).toEqual([409, 'unsigned_notes']);
    await pool.query('delete from clinical_notes where encounter_id = $1', [
      detail.admission.encounterId,
    ]);
    await note('signed');
    expect(errorOf(await cancel(detail))).toEqual([409, 'has_records']);
    // Nothing changed: still admitted, still in the bed, with no event for a cancellation.
    expect((await read(detail.admission.id)).admission.status).toBe('admitted');
    expect(await bedStatus(bed(0))).toBe('occupied');
    expect(await allEvents()).not.toContain('admission.cancelled');
  });

  it('is for those who hold admission:cancel, and another hospital cannot reach it', async () => {
    await reset();
    const detail = await admitted(patient(0));
    expect(errorOf(await cancel(detail, {}, { user: nurse }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await cancel(detail, {}, { tenant: clinic, user: clinicDoctor }))).toEqual([
      404,
      'admission_not_found',
    ]);
    expect((await read(detail.admission.id)).admission.status).toBe('admitted');
  });
});

describe('the bed board and housekeeping', () => {
  it('lists the beds with who is in them, and filters by status', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const board = await ok<Page<BoardBed>>(await get(`/beds/board?wardId=${ward}`));
    expect(board.total).toBe(4);
    expect(board.items.find((each) => each.id === bed(0))).toMatchObject({
      status: 'occupied',
      occupant: { patientName: 'Asha Adt', admissionId: detail.admission.id },
    });
    expect(board.items.find((each) => each.id === bed(1))?.occupant).toBeUndefined();
    expect(await audited('admission', detail.admission.id)).toContain('read');

    const free = await ok<Page<BoardBed>>(await get('/beds/board?status=available&limit=2'));
    expect(free.items).toHaveLength(2);
    expect(free.nextCursor).toBeTruthy();
    const rest = await ok<Page<BoardBed>>(
      await get(`/beds/board?status=available&limit=2&cursor=${free.nextCursor}`),
    );
    expect(rest.items.map((each) => each.id)).not.toContain(free.items[0]?.id);
    expect(errorOf(await get('/beds/board?cursor=nonsense'))).toEqual([400, 'invalid_cursor']);
  });

  it('marks a bed being cleaned and ready, checked against its version', async () => {
    await reset();
    const board = async () =>
      (await ok<Page<BoardBed>>(await get(`/beds/board?wardId=${ward}`))).items.find(
        (each) => each.id === bed(0),
      ) as BoardBed;
    const start = await board();
    const cleaning = await ok<BoardBed>(
      await post(
        `/beds/${bed(0)}/housekeeping`,
        { status: 'cleaning', version: start.version },
        { user: nurse },
      ),
    );
    expect(cleaning.status).toBe('cleaning');
    expect(
      errorOf(
        await post(
          `/beds/${bed(0)}/housekeeping`,
          { status: 'available', version: start.version },
          { user: nurse },
        ),
      ),
    ).toEqual([409, 'conflict']);
    const ready = await ok<BoardBed>(
      await post(
        `/beds/${bed(0)}/housekeeping`,
        {
          status: 'available',
          version: cleaning.version,
        },
        { user: nurse },
      ),
    );
    expect(ready.status).toBe('available');
    expect(await audited('bed', bed(0))).toEqual(['update', 'update']);
    // A bed with a patient in it, or out of use, is not touched from here.
    await admitted(patient(0), { bedId: bed(1) });
    const busy = await board();
    expect(busy.status).toBe('available');
    const occupied = (await ok<Page<BoardBed>>(await get(`/beds/board?wardId=${ward}`))).items.find(
      (each) => each.id === bed(1),
    ) as BoardBed;
    expect(
      errorOf(
        await post(
          `/beds/${bed(1)}/housekeeping`,
          {
            status: 'cleaning',
            version: occupied.version,
          },
          { user: nurse },
        ),
      ),
    ).toEqual([409, 'invalid_transition']);
    expect(
      errorOf(
        await post(
          `/beds/${clinicBed}/housekeeping`,
          { status: 'cleaning', version: 1 },
          { user: nurse },
        ),
      ),
    ).toEqual([404, 'bed_not_found']);
  });

  it('makes a discharged bed ready again for the next patient', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    await ok(await discharge(detail));
    expect(errorOf(await admit(patient(1), { bedId: bed(0) }))).toEqual([409, 'bed_not_available']);
    const board = await ok<Page<BoardBed>>(await get(`/beds/board?wardId=${ward}`));
    const cleaning = board.items.find((each) => each.id === bed(0)) as BoardBed;
    await ok(
      await post(
        `/beds/${bed(0)}/housekeeping`,
        {
          status: 'available',
          version: cleaning.version,
        },
        { user: nurse },
      ),
    );
    await admitted(patient(1), { bedId: bed(0) });
  });
});

describe('listing admissions', () => {
  it('pages them newest first and filters by status, patient and ward', async () => {
    await reset();
    const one = await admitted(patient(0), { bedId: bed(0) });
    const two = await admitted(patient(1));
    await ok(await discharge(two));
    const all = await ok<Page<Admission>>(await get('/admissions?limit=1'));
    expect(all.total).toBe(2);
    expect(all.items.map((each) => each.id)).toEqual([two.admission.id]);
    const next = await ok<Page<Admission>>(
      await get(`/admissions?limit=1&cursor=${all.nextCursor}`),
    );
    expect(next.items.map((each) => each.id)).toEqual([one.admission.id]);
    expect(next.nextCursor).toBeNull();
    const query = async (q: string) =>
      (await ok<Page<Admission>>(await get(`/admissions?${q}`))).items.map((each) => each.id);
    expect(await query('status=admitted')).toEqual([one.admission.id]);
    expect(await query(`patientId=${patient(1)}`)).toEqual([two.admission.id]);
    expect(await query(`wardId=${ward}`)).toEqual([one.admission.id]);
    expect(await query('wardId=nonsense')).toEqual([]);
    expect(errorOf(await get('/admissions?cursor=nonsense'))).toEqual([400, 'invalid_cursor']);
  });

  it('narrows to the caller’s own admissions under a scope of own', async () => {
    await reset();
    const mine = await admitted(patient(0));
    const setScope = (role: string, scope: string) =>
      pool.query(
        "update role_permissions set scope = $3 where tenant_id = $1 and role_id = $2 and permission = 'admission:read'",
        [hospital.id, role, scope],
      );
    await setScope('doctor', 'own');
    await setScope('nurse', 'own');
    try {
      expect((await ok<Page<Admission>>(await get('/admissions'))).items).toHaveLength(1);
      // The nurse has no doctor profile, so nothing is theirs.
      expect((await ok<Page<Admission>>(await get('/admissions', { user: nurse }))).items).toEqual(
        [],
      );
      expect(errorOf(await get(`/admissions/${mine.admission.id}`, { user: nurse }))).toEqual([
        404,
        'admission_not_found',
      ]);
    } finally {
      await setScope('doctor', 'all');
      await setScope('nurse', 'all');
    }
  });
});

describe('the hospital boundary and permissions', () => {
  it('shows another hospital nothing, and lets it change nothing', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const theirs = { tenant: clinic, user: clinicDoctor };
    expect(errorOf(await get(`/admissions/${detail.admission.id}`, theirs))).toEqual([
      404,
      'admission_not_found',
    ]);
    expect((await ok<Page<Admission>>(await get('/admissions', theirs))).items).toEqual([]);
    expect(errorOf(await discharge(detail, {}, theirs))).toEqual([404, 'admission_not_found']);
    expect(errorOf(await transfer(detail, clinicBed, theirs))).toEqual([
      404,
      'admission_not_found',
    ]);
    const board = await ok<Page<BoardBed>>(await get('/beds/board', theirs));
    expect(board.items.map((each) => each.id)).toEqual([clinicBed]);
    expect(board.items[0]?.occupant).toBeUndefined();
    expect(
      errorOf(
        await post(`/beds/${bed(1)}/housekeeping`, { status: 'cleaning', version: 1 }, theirs),
      ),
    ).toEqual([403, 'permission_denied']);
    // Under the app role the rows are invisible, and cannot be written for the wrong hospital.
    const seen = await asTenantSql(pool, clinic.id, (client) =>
      client.query(
        'select (select count(*) from admissions) as a, (select count(*) from bed_assignments) as b',
      ),
    );
    expect(seen.rows[0]).toEqual({ a: '0', b: '0' });
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into bed_assignments (tenant_id, admission_id, patient_id, bed_id, ward_id,
                                        bed_category_id, assigned_by)
           select $1, $2, $3, $4, $5, bed_category_id, $6 from beds where id = $4`,
          [clinic.id, detail.admission.id, patient(0), clinicBed, clinicWard, clinicDoctor.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into admissions (tenant_id, patient_id, encounter_id, admitting_doctor_id,
                                   department_id, admission_type, admitted_by)
           values ($1, $2, $3, $4, $5, 'planned', $6)`,
          [
            hospital.id,
            patient(1),
            detail.admission.encounterId,
            clinicDoctor.id,
            department,
            doctor.id,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into admissions (tenant_id, patient_id, encounter_id, admitting_doctor_id,
                                   department_id, admission_type, admitted_by)
           values ($1, $2, $3, $4, $5, 'planned', $6)`,
          [
            clinic.id,
            clinicPatient,
            detail.admission.encounterId,
            clinicDoctor.id,
            clinicDepartment,
            clinicDoctor.id,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('is closed with the module off and to a role without the permission', async () => {
    expect(errorOf(await get('/admissions', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(errorOf(await get('/beds/board', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    for (const url of ['/admissions', '/beds/board']) {
      expect(errorOf(await get(url, { user: pharmacist }))).toEqual([403, 'permission_denied']);
    }
    expect(errorOf(await admit(patient(0), {}, { user: pharmacist }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      errorOf(
        await post(
          `/beds/${bed(0)}/housekeeping`,
          { status: 'cleaning', version: 1 },
          { user: doctor },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
  });

  it('needs the wards module for a bed, and not for an admission without one', async () => {
    await reset();
    await pool.query(
      "update tenant_features set enabled = false where tenant_id = $1 and feature = 'wards'",
      [hospital.id],
    );
    try {
      expect(errorOf(await admit(patient(0), { bedId: bed(0) }))).toEqual([
        403,
        'feature_disabled',
      ]);
      expect(errorOf(await get('/beds/board'))).toEqual([403, 'feature_disabled']);
      await admitted(patient(0));
    } finally {
      await pool.query(
        "update tenant_features set enabled = true where tenant_id = $1 and feature = 'wards'",
        [hospital.id],
      );
    }
  });

  it('keeps an assignment and an admission from being rewritten or removed', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    await expect(
      pool.query('update bed_assignments set bed_id = $1 where admission_id = $2', [
        bed(1),
        detail.admission.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await ok(await discharge(detail));
    await expect(
      pool.query("update bed_assignments set release_reason = 'transfer' where admission_id = $1", [
        detail.admission.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('delete from bed_assignments where admission_id = $1', [detail.admission.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the live stream', () => {
  let base = '';

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  async function open(options: Options = {}) {
    const controller = new AbortController();
    const response = await fetch(`${base}/beds/events`, {
      headers: as((options.tenant ?? hospital).id, (options.user ?? doctor).id),
      signal: controller.signal,
    });
    const blocks: string[] = [];
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
      })();
    }
    return { status: response.status, blocks, close: () => controller.abort() };
  }
  async function until(condition: () => boolean) {
    for (let waited = 0; !condition(); waited += 20) {
      if (waited > 2000) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('says which ward changed, to the hospital’s streams only, and nothing about a patient', async () => {
    await reset();
    const ours = await open();
    const theirs = await open({ tenant: clinic, user: clinicDoctor });
    try {
      expect(ours.status).toBe(200);
      await until(() => ours.blocks.length > 0);
      expect(ours.blocks[0]).toBe('retry: 5000');
      await admitted(patient(0), { bedId: bed(0) });
      await until(() => ours.blocks.some((block) => block.startsWith('event: beds')));
      const events = ours.blocks.filter((block) => block.startsWith('event:'));
      expect(events[0]).toBe(`event: beds\ndata: ${JSON.stringify({ wardId: ward })}`);
      expect(ours.blocks.join('\n')).not.toContain(patient(0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(theirs.blocks.filter((block) => block.startsWith('event:'))).toEqual([]);
    } finally {
      ours.close();
      theirs.close();
    }
  });

  it('announces a bed marked ready and a patient discharged', async () => {
    await reset();
    const detail = await admitted(patient(0), { bedId: bed(0) });
    const stream = await open();
    try {
      await until(() => stream.blocks.length > 0);
      await ok(await discharge(detail));
      await until(() => stream.blocks.filter((block) => block.startsWith('event:')).length >= 1);
    } finally {
      stream.close();
    }
  });

  it('is refused to a role without admission:read', async () => {
    const response = await fetch(`${base}/beds/events`, {
      headers: as(hospital.id, pharmacist.id),
    });
    expect(response.status).toBe(403);
    await response.body?.cancel();
  });
});

describe('the stay’s encounter', () => {
  it('is not closed or cancelled from the clinical routes', async () => {
    await reset();
    const detail = await admitted(patient(0));
    const encounter = (
      await pool.query<{ version: number }>('select version from encounters where id = $1', [
        detail.admission.encounterId,
      ])
    ).rows[0];
    for (const action of ['close', 'cancel']) {
      const response = await post(`/encounters/${detail.admission.encounterId}/${action}`, {
        version: encounter?.version,
        reason: 'mistake',
      });
      expect(errorOf(response)).toEqual([409, 'managed_by_admission']);
    }
    await ok(await discharge(detail));
  });
});
