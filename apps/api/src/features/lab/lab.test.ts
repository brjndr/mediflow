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
  resultsEntered: number;
  resultsToVerify: number;
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
  patientName: string;
  patientMrn: string;
  priority: string;
  orderStatus: string;
  sample?: Sample;
  analytes: { labTestId: string; range?: { low?: number } }[];
  results: Result[];
  awaitingVerification?: string[];
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
      'lab_result_acknowledgements',
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
    expect(entered).toMatchObject({ patientName: 'Asha Test', priority: 'routine' });
    expect(entered.patientMrn).toMatch(/^LB-/);
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
    // The doctor reads results once verified, never one entered as final; the nurse reads none.
    const forDoctor = await resultsOf(order.id, { user: doctor });
    expect(forDoctor.results).toEqual([]);
    expect(forDoctor.awaitingVerification).toEqual([catalog.hb]);
    expect((await resultsOf(order.id)).awaitingVerification).toBeUndefined();
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

  it('gives the doctor a verified result, and the replaced one while its correction waits', async () => {
    const { order, sample } = await received();
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '13.2' }]),
      201,
    );
    const original = entered.results[0];
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [original?.id] }));
    const released = await resultsOf(order.id, { user: doctor });
    expect(released.results).toMatchObject([{ id: original?.id, value: '13.2' }]);
    expect(released.awaitingVerification).toEqual([]);
    const corrected = await ok<Result>(
      post(`/lab/results/${original?.id}/amend`, { value: '14.1', reason: 'Wrong patient tube' }),
      201,
    );
    const waiting = await resultsOf(order.id, { user: doctor });
    expect(waiting.results.map((r) => [r.id, r.amendedById])).toEqual([
      [original?.id, corrected.id],
    ]);
    expect(waiting.awaitingVerification).toEqual([catalog.hb]);
    expect(await audited('lab_result', corrected.id)).not.toContain('read');
  });

  it('lists completed orders the newest first, with what waits for verifying', async () => {
    const first = await received();
    const second = await received();
    for (const { sample } of [first, second]) {
      const r = await ok<OrderResults>(
        enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]),
        201,
      );
      await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [r.results[0]?.id] }));
    }
    const read = await resultsOf(first.order.id);
    await ok(
      post(`/lab/results/${read.results[0]?.id}/amend`, { value: '12.5', reason: 'Recalibrated' }),
      201,
    );
    const page = await worklist('completed');
    const ids = page.items.map((item) => item.orderId);
    expect(ids.indexOf(second.order.id)).toBeLessThan(ids.indexOf(first.order.id));
    expect(page.total).toBeUndefined();
    expect(page.items.find((item) => item.orderId === first.order.id)).toMatchObject({
      stage: 'completed',
      resultsEntered: 1,
      resultsToVerify: 1,
    });
    expect(page.items.find((item) => item.orderId === second.order.id)).toMatchObject({
      resultsEntered: 1,
      resultsToVerify: 0,
    });
    expect((await worklist('received')).items.map((item) => item.orderId)).not.toContain(
      first.order.id,
    );
    const paged: Page<WorkItem> = await ok(get('/lab/worklist?stage=completed&limit=1'));
    const next: Page<WorkItem> = await ok(
      get(`/lab/worklist?stage=completed&limit=1&cursor=${paged.nextCursor ?? ''}`),
    );
    expect(next.items[0]?.orderId).not.toBe(paged.items[0]?.orderId);
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

  it('gives verified results only to one who enters and verifies at a narrower scope', async () => {
    const { order, sample } = await received();
    await ok(enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]), 201);
    const setScope = (scope: string) =>
      pool.query(
        `update role_permissions set scope = $2
         where tenant_id = $1 and permission in ('labResult:enter', 'labResult:verify')
           and role_id = 'lab_technician'`,
        [hospital.id, scope],
      );
    await setScope('own');
    try {
      const read = await resultsOf(order.id);
      expect(read.results).toEqual([]);
      expect(read.awaitingVerification).toEqual([catalog.hb]);
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

describe('reports, acknowledgements and a patient’s results (#92)', () => {
  type Released = Result & {
    collectedAt: string;
    acknowledgedAt?: string;
    acknowledgedByName?: string;
  };

  /** A new patient's encounter, which places and receives samples of a test for them alone. */
  async function forNewPatient(labTestId = catalog.hb) {
    const patientId = await addPatient(hospital, 'Trend');
    const encounter = await ok<{ id: string }>(
      post('/encounters', { patientId }, { user: doctor }),
      201,
    );
    const another = async () => {
      const order = await ok<{ id: string }>(
        post(`/encounters/${encounter.id}/orders`, { type: 'lab', labTestId }, { user: doctor }),
        201,
      );
      return { order, sample: await receive(await collect(order.id)) };
    };
    return { patientId, encounterId: encounter.id, another };
  }

  /** Enters and verifies one value of a sample's test, giving the result's id. */
  async function resulted(sampleId: string, value: string, labTestId = catalog.hb) {
    const entered = await ok<OrderResults>(enter(sampleId, [{ labTestId, value }]), 201);
    const result = entered.results.find((r) => r.labTestId === labTestId && !r.amendedById);
    await ok(post(`/lab/samples/${sampleId}/verify`, { resultIds: [result?.id] }));
    return result?.id ?? '';
  }

  const search = (body: object, options: Options = {}) =>
    post('/lab/results/search', body, options);

  it('lists a patient’s verified results the newest collected first, by test and in pages', async () => {
    const patient = await forNewPatient();
    const first = await patient.another();
    const firstId = await resulted(first.sample.id, '13.1');
    const second = await patient.another();
    const secondId = await resulted(second.sample.id, '12.4');
    // Entered and not verified: not released.
    const third = await patient.another();
    await ok(enter(third.sample.id, [{ labTestId: catalog.hb, value: '11' }]), 201);

    const all = await ok<Page<Released>>(
      search({ patientId: patient.patientId }, { user: doctor }),
    );
    expect(all.items.map((r) => [r.id, r.value])).toEqual([
      [secondId, '12.4'],
      [firstId, '13.1'],
    ]);
    expect(all.items[0]?.collectedAt).toMatch(/Z$/);
    expect(await audited('lab_result', secondId)).toContain('read');

    const byTest = { patientId: patient.patientId, labTestId: catalog.hb, limit: 1 };
    const paged = await ok<Page<Released>>(search(byTest, { user: doctor }));
    expect(paged.items.map((r) => r.id)).toEqual([secondId]);
    const rest = await ok<Page<Released>>(
      search({ ...byTest, cursor: paged.nextCursor }, { user: doctor }),
    );
    expect(rest.items.map((r) => r.id)).toEqual([firstId]);
    expect(rest.nextCursor).toBeNull();
    const other = await ok<Page<Released>>(
      search({ patientId: patient.patientId, labTestId: catalog.alt }, { user: doctor }),
    );
    expect(other.items).toEqual([]);
    expect(errorOf(await search({ patientId: patient.patientId, cursor: 'nope' }))).toEqual([
      400,
      'invalid_cursor',
    ]);
    // The nurse reads no results; the clinic finds none of the hospital's.
    expect(errorOf(await search({ patientId: patient.patientId }, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    const fromClinic = await ok<Page<Released>>(
      search({ patientId: patient.patientId }, { tenant: clinic, user: clinicTech }),
    );
    expect(fromClinic.items).toEqual([]);
  });

  it('keeps the verified result while its correction waits, then gives the correction', async () => {
    const patient = await forNewPatient();
    const { sample } = await patient.another();
    const originalId = await resulted(sample.id, '13.2');
    const corrected = await ok<Result>(
      post(`/lab/results/${originalId}/amend`, { value: '14.1', reason: 'Transcription error' }),
      201,
    );
    const waiting = await ok<Page<Released>>(search({ patientId: patient.patientId }));
    expect(waiting.items.map((r) => r.id)).toEqual([originalId]);
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [corrected.id] }));
    const now = await ok<Page<Released>>(
      search({ patientId: patient.patientId, encounterId: patient.encounterId }),
    );
    expect(now.items.map((r) => [r.id, r.value])).toEqual([[corrected.id, '14.1']]);
  });

  it('has a doctor acknowledge a verified critical result once', async () => {
    const patient = await forNewPatient();
    const { order, sample } = await patient.another();
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '6.2' }]),
      201,
    );
    const id = entered.results[0]?.id ?? '';
    const acknowledge = (options: Options = {}) =>
      post(`/lab/results/${id}/acknowledge`, undefined, { user: doctor, ...options });
    // Not verified yet: nothing to acknowledge.
    expect(errorOf(await acknowledge())).toEqual([409, 'not_acknowledgeable']);
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [id] }));
    // The lab technician does not acknowledge; another hospital finds no such result.
    expect(errorOf(await acknowledge({ user: tech }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await acknowledge({ tenant: clinic }))).toEqual([404, 'result_not_found']);

    const key = randomUUID();
    const done = await ok<Released>(acknowledge({ key }));
    expect(done.acknowledgedAt).toBeDefined();
    expect(done.acknowledgedByName).toBe('Lab Doctor');
    expect(await audited('lab_result', id)).toContain('acknowledge');
    const acknowledged = async () =>
      (await events(id)).filter((e) => e.event === 'lab.critical_acknowledged');
    expect(await acknowledged()).toHaveLength(1);
    expect((await acknowledged())[0]?.payload).toMatchObject({
      resultId: id,
      patientId: patient.patientId,
    });
    // A repeat records nothing more; a second press is refused.
    await ok(acknowledge({ key }));
    expect(await acknowledged()).toHaveLength(1);
    expect(errorOf(await acknowledge())).toEqual([409, 'already_acknowledged']);
    const read = await resultsOf(order.id, { user: doctor });
    expect(read.results[0]).toMatchObject({ acknowledgedByName: 'Lab Doctor' });

    // A normal result is not acknowledged.
    const normal = await patient.another();
    const normalId = await resulted(normal.sample.id, '13');
    expect(
      errorOf(await post(`/lab/results/${normalId}/acknowledge`, undefined, { user: doctor })),
    ).toEqual([409, 'not_acknowledgeable']);
  });

  it('acknowledges only the critical result released, not one a verified correction replaced', async () => {
    const patient = await forNewPatient();
    const { sample } = await patient.another();
    const criticalId = await resulted(sample.id, '5');
    const acknowledge = (id: string) =>
      post(`/lab/results/${id}/acknowledge`, undefined, { user: doctor });
    // While its correction waits for verification, the critical one is still what is released.
    const corrected = await ok<Result>(
      post(`/lab/results/${criticalId}/amend`, { value: '5.5', reason: 'Recalibrated' }),
      201,
    );
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [corrected.id] }));
    // Verified, the correction replaces it: the old one is not acknowledged, the correction is.
    expect(errorOf(await acknowledge(criticalId))).toEqual([409, 'not_acknowledgeable']);
    await ok(acknowledge(corrected.id));
    await asTenantSql(pool, hospital.id, async (sql) => {
      await expect(
        sql.query(
          `insert into lab_result_acknowledgements (tenant_id, result_id, acknowledged_by)
           values ($1, $2, $3)`,
          [hospital.id, criticalId, doctor.id],
        ),
      ).rejects.toThrow();
    });

    // A correction still to verify leaves the critical one to acknowledge.
    const other = await patient.another();
    const pendingId = await resulted(other.sample.id, '6');
    await ok(post(`/lab/results/${pendingId}/amend`, { value: '13', reason: 'Wrong tube' }), 201);
    await ok(acknowledge(pendingId));
  });

  it('keeps acknowledgements to the hospital, and never changes or removes one', async () => {
    const patient = await forNewPatient();
    const { sample } = await patient.another();
    const id = await resulted(sample.id, '21');
    await ok(post(`/lab/results/${id}/acknowledge`, undefined, { user: doctor }));
    const seen = await asTenantSql(
      pool,
      clinic.id,
      async (sql) =>
        (await sql.query('select 1 from lab_result_acknowledgements where result_id = $1', [id]))
          .rowCount,
    );
    expect(seen).toBe(0);
    const normal = await patient.another();
    const normalId = await resulted(normal.sample.id, '13');
    const insert = (sql: pg.ClientBase, tenantId: string, resultId: string) =>
      sql.query(
        `insert into lab_result_acknowledgements (tenant_id, result_id, acknowledged_by)
         values ($1, $2, $3)`,
        [tenantId, resultId, doctor.id],
      );
    await asTenantSql(pool, hospital.id, async (sql) => {
      await sql.query('savepoint s');
      await expect(
        sql.query('update lab_result_acknowledgements set acknowledged_at = now()'),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      await expect(sql.query('delete from lab_result_acknowledgements')).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      // A row of another hospital, and a result that is not verified and critical, are refused.
      await expect(insert(sql, clinic.id, id)).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      await expect(insert(sql, hospital.id, normalId)).rejects.toThrow();
    });
  });

  it('records a report print once there is a verified result', async () => {
    const patient = await forNewPatient();
    const { order, sample } = await patient.another();
    const print = (options: Options = {}) =>
      post(`/lab/orders/${order.id}/print`, undefined, { user: doctor, ...options });
    expect(errorOf(await print())).toEqual([409, 'not_printable']);
    await resulted(sample.id, '13');
    const key = randomUUID();
    expect((await print({ key })).statusCode).toBe(204);
    expect((await print({ key })).statusCode).toBe(204);
    expect((await audited('lab_report', order.id)).filter((a) => a === 'print')).toHaveLength(1);
    expect((await print({ user: tech })).statusCode).toBe(204);
    expect(errorOf(await print({ user: nurse }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await print({ tenant: clinic, user: clinicTech }))).toEqual([
      404,
      'order_not_found',
    ]);
    expect(errorOf(await print({ tenant: closed, user: tech }))).toEqual([403, 'feature_disabled']);
  });

  it('refuses searching and acknowledging with the laboratory off, and acknowledging with no key', async () => {
    const patient = await forNewPatient();
    const { sample } = await patient.another();
    const id = await resulted(sample.id, '5');
    const offSearch = await search({ patientId: patient.patientId }, { tenant: closed });
    expect(errorOf(offSearch)).toEqual([403, 'feature_disabled']);
    const offAcknowledge = await post(`/lab/results/${id}/acknowledge`, undefined, {
      tenant: closed,
    });
    expect(errorOf(offAcknowledge)).toEqual([403, 'feature_disabled']);
    const keyless = await app.inject({
      method: 'POST',
      url: `/lab/results/${id}/acknowledge`,
      headers: as(hospital.id, doctor.id),
    });
    expect(keyless.statusCode).toBe(400);
  });
});

describe('outsourced tests (#94)', () => {
  const sendOut = (sample: Sample, body: object = {}, options: Options = {}) =>
    post(
      `/lab/samples/${sample.id}/send-out`,
      { version: sample.version, partnerLab: 'City Reference Lab', ...body },
      options,
    );
  const reportBack = (sample: Sample, options: Options = {}) =>
    post(`/lab/samples/${sample.id}/partner-report`, { version: sample.version }, options);

  interface Outsourced extends Sample {
    partnerLab?: string;
    partnerRef?: string;
    sentOutAt?: string;
    sentOutByName?: string;
    returnedAt?: string;
    returnedByName?: string;
  }

  it('sends a sample out, takes no results until its report is back, then results it', async () => {
    const { order, sample } = await received();
    const sent = await ok<Outsourced>(
      sendOut(sample, { partnerLab: '  City   Reference Lab ', partnerRef: 'CRL-7781' }),
    );
    expect(sent).toMatchObject({
      status: 'received',
      partnerLab: 'City Reference Lab',
      partnerRef: 'CRL-7781',
      sentOutByName: 'Lab Technician',
    });
    expect(sent.returnedAt).toBeUndefined();
    const out = await worklist('with_partner');
    expect(out.items.find((item) => item.orderId === order.id)?.sample).toMatchObject({
      partnerLab: 'City Reference Lab',
    });
    expect((await worklist('received')).items.some((item) => item.orderId === order.id)).toBe(
      false,
    );
    expect(errorOf(await enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]))).toEqual([
      409,
      'with_partner',
    ]);

    const back = await ok<Outsourced>(reportBack(sent));
    expect(back.returnedAt).toBeDefined();
    expect((await resultsOf(order.id)).sample).toMatchObject({ partnerRef: 'CRL-7781' });
    const entered = await ok<OrderResults>(
      enter(sample.id, [{ labTestId: catalog.hb, value: '13' }]),
      201,
    );
    await ok(post(`/lab/samples/${sample.id}/verify`, { resultIds: [entered.results[0]?.id] }));
    expect(await orderStatus(order.id)).toBe('completed');
    expect(await audited('lab_sample', sample.id)).toEqual([
      'create',
      'update',
      'update',
      'update',
    ]);
  });

  it('refuses what does not apply, without the permission, the switch or the hospital', async () => {
    const order = await placeOrder();
    const collected = await collect(order.id);
    expect(errorOf(await sendOut(collected))).toEqual([409, 'invalid_transition']);
    const sample = await receive(collected);
    expect(errorOf(await reportBack(sample))).toEqual([409, 'invalid_transition']);
    expect(errorOf(await sendOut(sample, { partnerLab: '   ' }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect(errorOf(await sendOut(sample, { partnerLab: 'Lab\u0000' }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect(errorOf(await sendOut(sample, {}, { user: nurse }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await sendOut(sample, {}, { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(errorOf(await sendOut(sample, {}, { tenant: clinic, user: clinicTech }))).toEqual([
      404,
      'sample_not_found',
    ]);
    const sent = await ok<Outsourced>(sendOut(sample));
    expect(errorOf(await sendOut(sent))).toEqual([409, 'invalid_transition']);
    const back = await ok<Outsourced>(reportBack(sent));
    expect(errorOf(await reportBack(back))).toEqual([409, 'invalid_transition']);

    const { sample: resulted } = await received();
    await ok(enter(resulted.id, [{ labTestId: catalog.hb, value: '13' }]), 201);
    const current = await ok<OrderResults>(get(`/lab/orders/${resulted.orderId}/results`));
    expect(errorOf(await sendOut(current.sample ?? resulted))).toEqual([409, 'has_results']);
  });

  it('changes nothing on a repeat, and never changes a send-out in the database', async () => {
    const { sample } = await received();
    const key = randomUUID();
    const sent = await ok<Outsourced>(sendOut(sample, {}, { key }));
    const again = await ok<Outsourced>(sendOut(sample, {}, { key }));
    expect(again.version).toBe(sent.version);
    await asTenantSql(pool, hospital.id, async (sql) => {
      await sql.query('savepoint s');
      await expect(
        sql.query("update lab_samples set partner_lab = 'Other' where id = $1", [sample.id]),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      await expect(
        sql.query(
          'update lab_samples set sent_out_at = null, sent_out_by = null, partner_lab = null, partner_ref = null where id = $1',
          [sample.id],
        ),
      ).rejects.toThrow();
    });
    const { sample: other } = await received();
    await asTenantSql(pool, hospital.id, async (sql) => {
      await sql.query('savepoint s');
      await expect(
        sql.query('update lab_samples set returned_at = now(), returned_by = $2 where id = $1', [
          other.id,
          tech.id,
        ]),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      // Sent out and back in one statement would take results with no report in hand.
      await expect(
        sql.query(
          `update lab_samples set sent_out_at = now(), sent_out_by = $2, partner_lab = 'X',
             returned_at = now(), returned_by = $2
           where id = $1`,
          [other.id, tech.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('rejects a sample while it is with the partner, so it is collected again', async () => {
    const { order, sample } = await received();
    const sent = await ok<Outsourced>(sendOut(sample));
    const rejected = await ok<Outsourced>(
      post(`/lab/samples/${sample.id}/reject`, { version: sent.version, reason: 'insufficient' }),
    );
    expect(rejected).toMatchObject({ status: 'rejected', partnerLab: 'City Reference Lab' });
    expect(
      (await worklist('to_collect')).items.find((item) => item.orderId === order.id),
    ).toBeDefined();
  });
});
