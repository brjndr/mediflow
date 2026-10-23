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
import { decimalOf, flagOf } from './results.js';

/**
 * The laboratory API through the real app and database: the worklist, collecting, receiving,
 * rejecting and labelling samples, entering, verifying and correcting results, and what they do
 * to the order; the hospital boundary, permissions, audit, events and the database's own rules.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** The laboratory switched off. */
let closed: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let nurse: TestUser;
let tech: TestUser;
let clinicTech: TestUser;
const catalog = { hb: '', panel: '', alt: '', remark: '', clinicHb: '' };
const patients = { asha: '', clinic: '' };

interface Sample {
  id: string;
  orderId: string;
  accessionId: string;
  status: string;
  sampleType: string;
  container?: string;
  rejectReason?: string;
  version: number;
}
interface WorkItem {
  orderId: string;
  patientName: string;
  patientMrn: string;
  patientDob?: string;
  stage: string;
  orderStatus: string;
  sample?: Sample;
  rejectedSamples: number;
}
interface Result {
  id: string;
  labTestId: string;
  value: string;
  flag?: string;
  unit?: string;
  range?: { low?: number; high?: number; criticalLow?: number };
  status: string;
  amendsId?: string;
  amendedById?: string;
}
interface OrderResults {
  orderStatus: string;
  sample?: Sample;
  analytes: { labTestId: string; range?: { low?: number } }[];
  results: Result[];
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Reply = {
  statusCode: number;
  body: string;
  json: <T = { error: { code: string } }>() => T;
};

const get = (url: string, options: Options = {}) =>
  app.inject({ url, headers: as((options.tenant ?? hospital).id, (options.user ?? tech).id) });
const post = (url: string, body?: object, options: Options = {}) => {
  const { tenant = hospital, user = tech, key = randomUUID() } = options;
  return app.inject({
    method: 'POST',
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': key },
    ...(body === undefined ? {} : { payload: body }),
  });
};
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

async function ok<T>(response: Promise<Reply> | Reply, status = 200): Promise<T> {
  const reply = await response;
  if (reply.statusCode !== status) {
    throw new Error(`expected ${status}, got ${reply.statusCode} ${reply.body}`);
  }
  return reply.json<T>();
}

/** A lab order of a new walk-in encounter, placed by the doctor. */
async function placeOrder(labTestId = catalog.hb, tenant = hospital, user = doctor) {
  const patientId = tenant === hospital ? patients.asha : patients.clinic;
  const encounter = await ok<{ id: string }>(
    post('/encounters', { patientId }, { tenant, user }),
    201,
  );
  return ok<{ id: string; version: number }>(
    post(`/encounters/${encounter.id}/orders`, { type: 'lab', labTestId }, { tenant, user }),
    201,
  );
}

const collect = (orderId: string, options: Options = {}) =>
  ok<Sample>(post(`/lab/orders/${orderId}/samples`, undefined, options), 201);
const receive = (sample: Sample, options: Options = {}) =>
  ok<Sample>(post(`/lab/samples/${sample.id}/receive`, { version: sample.version }, options));
const enter = (sampleId: string, results: object[], options: Options = {}) =>
  post(`/lab/samples/${sampleId}/results`, { results }, options);
const resultsOf = (orderId: string, options: Options = {}) =>
  ok<OrderResults>(get(`/lab/orders/${orderId}/results`, options));

/** An order with a received sample, ready for results. */
async function received(labTestId = catalog.hb) {
  const order = await placeOrder(labTestId);
  const sample = await receive(await collect(order.id));
  return { order, sample };
}

const worklist = (stage: string, options: Options = {}) =>
  ok<Page<WorkItem>>(get(`/lab/worklist?stage=${stage}&limit=100`, options));

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

const orderStatus = async (orderId: string) =>
  (await pool.query<{ status: string }>('select status from orders where id = $1', [orderId]))
    .rows[0]?.status;

const tenants = () => [hospital.id, clinic.id, closed.id];

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Test', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `LB-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

async function addDoctor(tenant: TestTenant, user: TestUser) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, 'General'],
  );
  await pool.query(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General', 15)`,
    [tenant.id, user.id, rows[0]?.id],
  );
}

async function addTest(
  tenant: TestTenant,
  code: string,
  kind: 'test' | 'panel',
  resultType: 'numeric' | 'text',
  unit: string | null = null,
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into lab_tests (tenant_id, code, name, department, kind, result_type, unit, sample_type,
                            container, turnaround_hours)
     values ($1, $2, $3, 'haematology', $4, $5, $6, 'blood', 'EDTA tube', 4) returning id`,
    [tenant.id, code, `${code} test`, kind, resultType, unit],
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { clinical: true, patients: true, lab_tests: true, laboratory: true };
  hospital = await createTenant(pool, 'Lab Hospital', { features });
  clinic = await createTenant(pool, 'Lab Clinic', { features });
  closed = await createTenant(pool, 'Lab Closed', { features: { ...features, laboratory: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Lab Admin');
  doctor = await user('Lab Doctor');
  nurse = await user('Lab Nurse');
  tech = await user('Lab Technician');
  clinicTech = await user('Clinic Technician');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, tech, hospital, 'lab_technician');
  await addMembership(pool, tech, closed, 'lab_technician');
  await addMembership(pool, clinicTech, clinic, 'lab_technician');
  await addDoctor(hospital, doctor);
  await addDoctor(clinic, doctor);
  patients.asha = await addPatient(hospital, 'Asha');
  patients.clinic = await addPatient(clinic, 'Dina');

  catalog.hb = await addTest(hospital, 'HB', 'test', 'numeric', 'g/dL');
  await pool.query(
    `insert into lab_test_ranges (tenant_id, lab_test_id, position, sex, age_from_value,
       age_from_unit, low, high, critical_low, critical_high)
     values ($1, $2, 0, 'female', 18, 'years', 12, 15.5, 7, 20),
            ($1, $2, 1, 'male', 18, 'years', 13, 17, 7, 20)`,
    [hospital.id, catalog.hb],
  );
  catalog.alt = await addTest(hospital, 'ALT', 'test', 'numeric', 'U/L');
  catalog.remark = await addTest(hospital, 'REM', 'test', 'text');
  catalog.panel = await addTest(hospital, 'LFT', 'panel', 'text');
  await pool.query(
    `insert into lab_test_components (tenant_id, panel_id, component_id, position)
     values ($1, $2, $3, 0), ($1, $2, $4, 1)`,
    [hospital.id, catalog.panel, catalog.alt, catalog.remark],
  );
  catalog.clinicHb = await addTest(clinic, 'HB', 'test', 'numeric', 'g/dL');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'lab_results',
      'lab_samples',
      'lab_accession_counters',
      'orders',
      'encounters',
      'outbox',
      'lab_test_ranges',
      'lab_test_components',
      'lab_tests',
      'doctors',
      'departments',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, doctor, nurse, tech, clinicTech]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('result rules', () => {
  it('takes a decimal number as typed and refuses anything else', () => {
    expect(decimalOf(' 5.10 ')).toBe('5.10');
    expect(decimalOf('-0.25')).toBe('-0.25');
    for (const bad of ['abc', '1e3', '5,1', '', '.5', '1234567890', '1.1234567']) {
      expect(decimalOf(bad)).toBeNull();
    }
  });

  it('reads the critical limits first, then the normal range', () => {
    const range = { low: 12, high: 15.5, criticalLow: 7, criticalHigh: 20 };
    expect(flagOf(7, range)).toBe('critical_low');
    expect(flagOf(11.9, range)).toBe('low');
    expect(flagOf(12, range)).toBe('normal');
    expect(flagOf(15.6, range)).toBe('high');
    expect(flagOf(20, range)).toBe('critical_high');
    // A range that contradicts itself (#310) still gives one flag.
    expect(flagOf(4, { high: 5, criticalLow: 4 })).toBe('critical_low');
    expect(flagOf(5, { low: 5, high: 9, criticalLow: 5 })).toBe('critical_low');
  });
});

describe('the worklist and samples', () => {
  it('lists an order to collect with its patient, and audits each row', async () => {
    const order = await placeOrder();
    const page = await worklist('to_collect');
    const item = page.items.find((each) => each.orderId === order.id);
    expect(item).toMatchObject({
      patientName: 'Asha Test',
      patientDob: '1980-05-01',
      stage: 'to_collect',
      orderStatus: 'placed',
      rejectedSamples: 0,
    });
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(await audited('order', order.id)).toContain('read');
    // The nurse collects; the clinic's technician and another hospital see nothing of it.
    expect((await worklist('to_collect', { user: nurse })).items.map((i) => i.orderId)).toContain(
      order.id,
    );
    const elsewhere = await worklist('to_collect', { tenant: clinic, user: clinicTech });
    expect(elsewhere.items.map((i) => i.orderId)).not.toContain(order.id);
  });

  it('refuses without the permission or the switch', async () => {
    expect(errorOf(await get('/lab/worklist?limit=25', { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await get('/lab/worklist?limit=25', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(errorOf(await get('/lab/worklist?limit=25&cursor=nope'))).toEqual([
      400,
      'invalid_cursor',
    ]);
  });

  it('collects once, numbers the sample and accepts the order', async () => {
    const order = await placeOrder();
    const key = randomUUID();
    const sample = await collect(order.id, { key });
    expect(sample.accessionId).toMatch(/^\d{6}-\d{4}$/);
    expect(sample).toMatchObject({
      status: 'collected',
      sampleType: 'blood',
      container: 'EDTA tube',
    });
    expect(await orderStatus(order.id)).toBe('accepted');
    // A repeat answers with the same sample; another collection is refused.
    expect((await collect(order.id, { key })).id).toBe(sample.id);
    expect(errorOf(await post(`/lab/orders/${order.id}/samples`))).toEqual([
      409,
      'already_collected',
    ]);
    expect(await audited('lab_sample', sample.id)).toEqual(['create', 'read']);
    expect((await events(sample.id)).map((e) => e.event)).toEqual(['lab.sample_collected']);
    const item = (await worklist('collected')).items.find((each) => each.orderId === order.id);
    expect(item?.sample?.id).toBe(sample.id);
  });

  it('gives one of two collections at the same moment, and numbers in sequence', async () => {
    const order = await placeOrder();
    const replies = await Promise.all([
      post(`/lab/orders/${order.id}/samples`),
      post(`/lab/orders/${order.id}/samples`),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    const other = await collect((await placeOrder()).id);
    const first = replies.find((reply) => reply.statusCode === 201)?.json<Sample>();
    const number = (accession: string) => Number(accession.split('-')[1]);
    expect(number(other.accessionId)).toBe(number(first?.accessionId ?? '') + 1);
  });

  it('does not collect a cancelled order, nor one of another hospital', async () => {
    const order = await placeOrder();
    await ok(
      post(
        `/orders/${order.id}/cancel`,
        { version: order.version, reason: 'Duplicate' },
        {
          user: doctor,
        },
      ),
    );
    expect(errorOf(await post(`/lab/orders/${order.id}/samples`))).toEqual([
      409,
      'invalid_transition',
    ]);
    const mine = await placeOrder();
    expect(
      errorOf(
        await post(`/lab/orders/${mine.id}/samples`, undefined, {
          tenant: clinic,
          user: clinicTech,
        }),
      ),
    ).toEqual([404, 'order_not_found']);
  });

  it('receives a collected sample once, at its version', async () => {
    const sample = await collect((await placeOrder()).id);
    expect(
      errorOf(await post(`/lab/samples/${sample.id}/receive`, { version: sample.version + 1 })),
    ).toEqual([409, 'conflict']);
    const got = await receive(sample);
    expect(got.status).toBe('received');
    expect(
      errorOf(await post(`/lab/samples/${sample.id}/receive`, { version: got.version })),
    ).toEqual([409, 'invalid_transition']);
    expect(
      errorOf(
        await post(
          `/lab/samples/${sample.id}/receive`,
          { version: got.version },
          {
            user: nurse,
          },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
  });

  it('rejects with a reason, so the order is collected again', async () => {
    const order = await placeOrder();
    const sample = await collect(order.id);
    expect(
      errorOf(
        await post(`/lab/samples/${sample.id}/reject`, {
          version: sample.version,
          reason: 'other',
        }),
      ),
    ).toEqual([400, 'validation_failed']);
    const rejected = await ok<Sample>(
      post(`/lab/samples/${sample.id}/reject`, { version: sample.version, reason: 'haemolysed' }),
    );
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'haemolysed' });
    expect((await events(sample.id)).map((e) => e.event)).toContain('lab.sample_rejected');
    expect(errorOf(await post(`/lab/samples/${sample.id}/print`))).toEqual([409, 'not_printable']);
    const item = (await worklist('to_collect')).items.find((each) => each.orderId === order.id);
    expect(item).toMatchObject({ rejectedSamples: 1, sample: { id: sample.id } });
    const again = await collect(order.id);
    expect(again.accessionId).not.toBe(sample.accessionId);
  });

  it('records a label print in the audit log', async () => {
    const sample = await collect((await placeOrder()).id);
    expect((await post(`/lab/samples/${sample.id}/print`)).statusCode).toBe(204);
    expect(await audited('lab_sample', sample.id)).toContain('print');
  });
});

describe('results', () => {
  it('enters a number against the patient’s range and moves the order in progress', async () => {
    const order = await placeOrder();
    const collected = await collect(order.id);
    expect(errorOf(await enter(collected.id, [{ labTestId: catalog.hb, value: '13' }]))).toEqual([
      409,
      'invalid_transition',
    ]);
    const sample = await receive(collected);
    expect(errorOf(await enter(sample.id, [{ labTestId: catalog.hb, value: 'high' }]))).toEqual([
      422,
      'invalid_number',
    ]);
    expect(errorOf(await enter(sample.id, [{ labTestId: catalog.alt, value: '3' }]))).toEqual([
      422,
      'unknown_test',
    ]);
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '6.50' }]),
      201,
    );
    expect(entered.orderStatus).toBe('in_progress');
    const result = entered.results[0];
    expect(result).toMatchObject({
      value: '6.50',
      unit: 'g/dL',
      flag: 'critical_low',
      status: 'entered',
      range: { low: 12, high: 15.5, criticalLow: 7 },
    });
    expect((await events(result?.id ?? '')).map((e) => e.event)).toEqual(['lab.critical_value']);
    expect(await audited('lab_result', result?.id ?? '')).toContain('create');
    expect(errorOf(await enter(sample.id, [{ labTestId: catalog.hb, value: '7' }]))).toEqual([
      409,
      'already_resulted',
    ]);
    // The doctor reads results; the nurse does not.
    expect((await resultsOf(order.id, { user: doctor })).results).toHaveLength(1);
    expect(errorOf(await get(`/lab/orders/${order.id}/results`, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    // A sample with results is not rejected.
    expect(
      errorOf(
        await post(`/lab/samples/${sample.id}/reject`, {
          version: sample.version,
          reason: 'clotted',
        }),
      ),
    ).toEqual([409, 'has_results']);
  });

  it('completes a panel only once every test is verified', async () => {
    const { order, sample } = await received(catalog.panel);
    const first = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.alt, value: '40' }]),
      201,
    );
    expect(first.analytes.map((a) => a.labTestId)).toEqual([catalog.alt, catalog.remark]);
    const alt = first.results[0];
    expect(alt?.flag).toBeUndefined();
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [alt?.id] }));
    expect(await orderStatus(order.id)).toBe('in_progress');
    const both = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.remark, value: 'No abnormality' }]),
      201,
    );
    const remark = both.results.find((r) => r.labTestId === catalog.remark);
    const done = await ok<OrderResults>(
      post(`/lab/samples/${sample.id}/verify`, { resultIds: [remark?.id] }),
    );
    expect(done.orderStatus).toBe('completed');
    expect(done.results.every((r) => r.status === 'verified')).toBe(true);
    expect((await events(sample.id)).map((e) => e.event)).toContain('lab.result_verified');
    expect((await events(order.id)).map((e) => e.event)).toContain('order.completed');
  });

  it('corrects a verified result once, and verifies the correction', async () => {
    const { order, sample } = await received();
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '13.2' }]),
      201,
    );
    const original = entered.results[0];
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [original?.id] }));
    expect(await orderStatus(order.id)).toBe('completed');
    const amend = { value: '14.1', reason: 'Transcription error' };
    const corrected = await ok<Result>(post(`/lab/results/${original?.id}/amend`, amend), 201);
    expect(corrected).toMatchObject({ amendsId: original?.id, status: 'entered', flag: 'normal' });
    expect(errorOf(await post(`/lab/results/${original?.id}/amend`, amend))).toEqual([
      409,
      'already_amended',
    ]);
    // The replaced one is history, and verifying it again is refused.
    expect(
      errorOf(await post(`/lab/samples/${sample.id}/verify`, { resultIds: [original?.id] })),
    ).toEqual([409, 'conflict']);
    const read = await resultsOf(order.id);
    expect(read.results.find((r) => r.id === original?.id)?.amendedById).toBe(corrected.id);
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [corrected.id] }));
    const verified = (await events(sample.id)).filter((e) => e.event === 'lab.result_verified');
    expect(verified).toHaveLength(2);
    expect(await orderStatus(order.id)).toBe('completed');
  });

  it('enters nothing more on a repeat', async () => {
    const { sample } = await received();
    const key = randomUUID();
    const body = [{ labTestId: catalog.hb, value: '13' }];
    await ok(enter(sample.id, body, { key }), 201);
    const again = await ok<OrderResults>(enter(sample.id, body, { key }), 201);
    expect(again.results).toHaveLength(1);
  });
});

describe('the database', () => {
  it('keeps samples and results to the hospital', async () => {
    const { sample } = await received();
    await ok(enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]), 201);
    const seen = await asTenantSql(pool, clinic.id, async (sql) => ({
      samples: (await sql.query('select 1 from lab_samples where id = $1', [sample.id])).rowCount,
      results: (await sql.query('select 1 from lab_results where sample_id = $1', [sample.id]))
        .rowCount,
    }));
    expect(seen).toEqual({ samples: 0, results: 0 });
    const order = await placeOrder(catalog.clinicHb, clinic);
    const { rows } = await pool.query<{ encounter_id: string; patient_id: string }>(
      'select encounter_id, patient_id from orders where id = $1',
      [order.id],
    );
    const insert = (tenantId: string) =>
      asTenantSql(pool, tenantId, (sql) =>
        sql.query(
          `insert into lab_samples (tenant_id, order_id, encounter_id, patient_id, lab_test_id,
                                    accession_id, sample_type, collected_by)
           values ($1, $2, $3, $4, $5, '990101-0001', 'blood', $6)`,
          [
            clinic.id,
            order.id,
            rows[0]?.encounter_id,
            rows[0]?.patient_id,
            catalog.clinicHb,
            tech.id,
          ],
        ),
      );
    // Under the hospital, a row of the clinic is refused; the clinic itself may write it.
    await expect(insert(hospital.id)).rejects.toThrow();
    await expect(insert(clinic.id)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('never changes or removes a result, and refuses a sample moving back', async () => {
    const { sample } = await received();
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]),
      201,
    );
    const id = entered.results[0]?.id;
    await asTenantSql(pool, hospital.id, async (sql) => {
      await sql.query('savepoint s');
      await expect(
        sql.query('update lab_results set value_number = 1 where id = $1', [id]),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      await expect(sql.query('delete from lab_results where id = $1', [id])).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      await expect(
        sql.query("update lab_samples set status = 'collected' where id = $1", [sample.id]),
      ).rejects.toThrow();
    });
  });
});

describe('the edges', () => {
  /** A lab order of a new walk-in encounter, at a priority. */
  async function placeAt(priority: 'routine' | 'urgent' | 'stat') {
    const encounter = await ok<{ id: string }>(
      post('/encounters', { patientId: patients.asha }, { user: doctor }),
      201,
    );
    return ok<{ id: string }>(
      post(
        `/encounters/${encounter.id}/orders`,
        { type: 'lab', labTestId: catalog.hb, priority },
        { user: doctor },
      ),
      201,
    );
  }

  it('pages the worklist stat first, then urgent, then routine, and filters by priority', async () => {
    const routine = await placeAt('routine');
    const stat = await placeAt('stat');
    const urgent = await placeAt('urgent');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : '';
      const page: Page<WorkItem> = await ok(get(`/lab/worklist?stage=to_collect&limit=2${query}`));
      seen.push(...page.items.map((item) => item.orderId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.indexOf(stat.id)).toBeLessThan(seen.indexOf(urgent.id));
    expect(seen.indexOf(urgent.id)).toBeLessThan(seen.indexOf(routine.id));
    const stats = await ok<Page<WorkItem>>(
      get('/lab/worklist?stage=to_collect&priority=stat&limit=100'),
    );
    expect(stats.items.map((item) => item.orderId)).toContain(stat.id);
    expect(stats.items.map((item) => item.orderId)).not.toContain(routine.id);
  });

  it('reaches nothing with a narrower scope', async () => {
    const order = await placeOrder();
    const setScope = (scope: string) =>
      pool.query(
        `update role_permissions set scope = $2
         where tenant_id = $1 and permission in ('labSample:read', 'labSample:collect')
           and role_id = 'lab_technician'`,
        [hospital.id, scope],
      );
    await setScope('own');
    try {
      expect((await worklist('to_collect')).items).toEqual([]);
      expect(errorOf(await post(`/lab/orders/${order.id}/samples`))).toEqual([
        404,
        'order_not_found',
      ]);
    } finally {
      await setScope('all');
    }
  });

  it('leaves a lab order to the laboratory while it is switched on', async () => {
    const order = await placeOrder();
    const reply = await post(
      `/orders/${order.id}/status`,
      { status: 'accepted', version: 1 },
      { user: nurse },
    );
    expect(errorOf(reply)).toEqual([409, 'lab_order']);
  });

  it('refuses receiving once the doctor cancelled the order', async () => {
    const order = await placeOrder();
    const sample = await collect(order.id);
    await ok(
      post(
        `/orders/${order.id}/cancel`,
        { version: order.version + 1, reason: 'Not needed' },
        { user: doctor },
      ),
    );
    const reply = await post(`/lab/samples/${sample.id}/receive`, { version: sample.version });
    expect(errorOf(reply)).toEqual([409, 'invalid_transition']);
  });

  it('changes nothing on a repeat of receiving, verifying, correcting or printing', async () => {
    const order = await placeOrder();
    const sample = await collect(order.id);
    const key = randomUUID();
    const body = { version: sample.version };
    const first = await ok<Sample>(post(`/lab/samples/${sample.id}/receive`, body, { key }));
    const again = await ok<Sample>(post(`/lab/samples/${sample.id}/receive`, body, { key }));
    expect(again.version).toBe(first.version);
    expect(await audited('lab_sample', sample.id)).toEqual(['create', 'update', 'read']);

    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]),
      201,
    );
    const resultId = entered.results[0]?.id ?? '';
    const verifyKey = randomUUID();
    const verify = { resultIds: [resultId] };
    await ok(post(`/lab/samples/${sample.id}/verify`, verify, { key: verifyKey }));
    await ok(post(`/lab/samples/${sample.id}/verify`, verify, { key: verifyKey }));
    const verified = (await events(sample.id)).filter((e) => e.event === 'lab.result_verified');
    expect(verified).toHaveLength(1);

    const amendKey = randomUUID();
    const amend = { value: '13.4', reason: 'Recalibrated' };
    const one = await ok<Result>(
      post(`/lab/results/${resultId}/amend`, amend, { key: amendKey }),
      201,
    );
    const two = await ok<Result>(
      post(`/lab/results/${resultId}/amend`, amend, { key: amendKey }),
      201,
    );
    expect(two.id).toBe(one.id);

    const printKey = randomUUID();
    await post(`/lab/samples/${sample.id}/print`, undefined, { key: printKey });
    await post(`/lab/samples/${sample.id}/print`, undefined, { key: printKey });
    const prints = (await audited('lab_sample', sample.id)).filter((a) => a === 'print');
    expect(prints).toHaveLength(1);
  });

  it('refuses a test twice, a result not of the sample and a correction with no reason', async () => {
    const { sample } = await received(catalog.panel);
    const twice = await enter(sample.id, [
      { labTestId: catalog.alt, value: '1' },
      { labTestId: catalog.alt, value: '2' },
    ]);
    expect(errorOf(twice)).toEqual([400, 'validation_failed']);
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.remark, value: 'Clear' }]),
      201,
    );
    const unknown = await post(`/lab/samples/${sample.id}/verify`, { resultIds: [randomUUID()] });
    expect(errorOf(unknown)).toEqual([422, 'unknown_result']);
    const remark = entered.results[0];
    const blank = await post(`/lab/results/${remark?.id}/amend`, { value: 'Cloudy', reason: ' ' });
    expect(errorOf(blank)).toEqual([400, 'validation_failed']);
    // A text result is corrected as text, with no flag.
    const corrected = await ok<Result>(
      post(`/lab/results/${remark?.id}/amend`, { value: 'Cloudy', reason: 'Misread' }),
      201,
    );
    expect(corrected).toMatchObject({ value: 'Cloudy', amendsId: remark?.id });
    expect(corrected.flag).toBeUndefined();
  });

  it('answers another hospital’s samples and results as ones that do not exist', async () => {
    const { order, sample } = await received();
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]),
      201,
    );
    const resultId = entered.results[0]?.id ?? '';
    const asClinic = { tenant: clinic, user: clinicTech };
    const replies = [
      await post(`/lab/samples/${sample.id}/receive`, { version: sample.version }, asClinic),
      await post(
        `/lab/samples/${sample.id}/reject`,
        { version: sample.version, reason: 'clotted' },
        asClinic,
      ),
      await post(`/lab/samples/${sample.id}/print`, undefined, asClinic),
      await enter(sample.id, [{ labTestId: catalog.hb, value: '1' }], asClinic),
      await post(`/lab/samples/${sample.id}/verify`, { resultIds: [resultId] }, asClinic),
    ];
    for (const reply of replies) expect(errorOf(reply)).toEqual([404, 'sample_not_found']);
    expect(errorOf(await get(`/lab/orders/${order.id}/results`, asClinic))).toEqual([
      404,
      'order_not_found',
    ]);
    const amend = await post(
      `/lab/results/${resultId}/amend`,
      { value: '1', reason: 'Typo' },
      asClinic,
    );
    expect(errorOf(amend)).toEqual([404, 'result_not_found']);
    const counters = await asTenantSql(
      pool,
      clinic.id,
      async (sql) =>
        (
          await sql.query('select 1 from lab_accession_counters where tenant_id = $1', [
            hospital.id,
          ])
        ).rowCount,
    );
    expect(counters).toBe(0);
  });
});
