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

/**
 * The radiology API through the real app and database: the worklist, scheduling, rescheduling,
 * unscheduling and performing a study, and what they do to the order; the hospital boundary,
 * permissions, audit, events and the database's own rules.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** Radiology switched off. */
let closed: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let radiologist: TestUser;
let clinicRadiologist: TestUser;
const catalog = { chest: '', knee: '', clinicChest: '' };
const patients = { asha: '', clinic: '' };

interface Study {
  id: string;
  orderId: string;
  modality: string;
  scheduledAt?: string;
  scheduledByName?: string;
  performedAt?: string;
  performedByName?: string;
  version: number;
}
interface WorkItem {
  orderId: string;
  patientName: string;
  patientMrn: string;
  patientDob?: string;
  itemName: string;
  modality: string;
  priority: string;
  stage: string;
  orderStatus: string;
  study?: Study;
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
  app.inject({
    url,
    headers: as((options.tenant ?? hospital).id, (options.user ?? radiologist).id),
  });
const post = (url: string, body?: object, options: Options = {}) => {
  const { tenant = hospital, user = radiologist, key = randomUUID() } = options;
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

const SLOT = 15 * 60_000;
/** The start of a slot `steps` slots after the next one. */
const slot = (steps = 0) =>
  new Date((Math.floor(Date.now() / SLOT) + 1 + steps) * SLOT).toISOString();

/** An imaging order of a new walk-in encounter, placed by the doctor. */
async function placeOrder(
  serviceId = catalog.chest,
  { tenant = hospital, priority = 'routine' }: { tenant?: TestTenant; priority?: string } = {},
) {
  const patientId = tenant === hospital ? patients.asha : patients.clinic;
  const encounter = await ok<{ id: string }>(
    post('/encounters', { patientId }, { tenant, user: doctor }),
    201,
  );
  return ok<{ id: string; version: number }>(
    post(
      `/encounters/${encounter.id}/orders`,
      { type: 'imaging', serviceId, priority },
      { tenant, user: doctor },
    ),
    201,
  );
}

const schedule = (orderId: string, body: object, options: Options = {}) =>
  post(`/radiology/orders/${orderId}/schedule`, body, options);
const scheduled = async (serviceId = catalog.chest) => {
  const order = await placeOrder(serviceId);
  const study = await ok<Study>(schedule(order.id, { scheduledAt: slot() }));
  return { order, study };
};
const perform = (study: Study, options: Options = {}) =>
  post(`/radiology/orders/${study.orderId}/perform`, { version: study.version }, options);
const unschedule = (study: Study, options: Options = {}) =>
  post(`/radiology/orders/${study.orderId}/unschedule`, { version: study.version }, options);

const worklist = (query: string, options: Options = {}) =>
  ok<Page<WorkItem>>(get(`/radiology/worklist?limit=100&${query}`, options));
const itemOf = async (orderId: string, stage: string) =>
  (await worklist(`stage=${stage}`)).items.find((each) => each.orderId === orderId);

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
    [tenant.id, `RD-${String(mrn).padStart(7, '0')}`, first],
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

async function addService(tenant: TestTenant, code: string, modality: string | null) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into services (tenant_id, code, name, category, tax_class, modality)
     values ($1, $2, $3, 'imaging', 'exempt', $4) returning id`,
    [tenant.id, code, `${code} study`, modality],
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { clinical: true, patients: true, services: true, radiology: true };
  hospital = await createTenant(pool, 'Radiology Hospital', { features });
  clinic = await createTenant(pool, 'Radiology Clinic', { features });
  closed = await createTenant(pool, 'Radiology Closed', {
    features: { ...features, radiology: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Radiology Admin');
  doctor = await user('Radiology Doctor');
  radiologist = await user('Radiologist');
  clinicRadiologist = await user('Clinic Radiologist');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, doctor, closed, 'doctor');
  await addMembership(pool, radiologist, hospital, 'radiologist');
  await addMembership(pool, radiologist, closed, 'radiologist');
  await addMembership(pool, clinicRadiologist, clinic, 'radiologist');
  await addDoctor(hospital, doctor);
  await addDoctor(clinic, doctor);
  await addDoctor(closed, doctor);
  patients.asha = await addPatient(hospital, 'Asha');
  patients.clinic = await addPatient(clinic, 'Dina');
  catalog.chest = await addService(hospital, 'XR-CHEST', 'xray');
  catalog.knee = await addService(hospital, 'MR-KNEE', null);
  catalog.clinicChest = await addService(clinic, 'XR-CHEST', 'xray');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'imaging_studies',
      'orders',
      'encounters',
      'outbox',
      'services',
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
  await deleteUsers(pool, [admin, doctor, radiologist, clinicRadiologist]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('the worklist', () => {
  it('lists an order to schedule with its patient and modality, and audits each row', async () => {
    const order = await placeOrder();
    const page = await worklist('stage=to_schedule');
    expect(page.items.find((each) => each.orderId === order.id)).toMatchObject({
      patientName: 'Asha Test',
      patientDob: '1980-05-01',
      itemName: 'XR-CHEST study',
      modality: 'xray',
      stage: 'to_schedule',
      orderStatus: 'placed',
    });
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(await audited('order', order.id)).toContain('read');
    // The admin sees it too; another hospital's radiologist does not.
    expect((await worklist('', { user: admin })).items.map((i) => i.orderId)).toContain(order.id);
    expect(
      (await worklist('', { tenant: clinic, user: clinicRadiologist })).items.map((i) => i.orderId),
    ).not.toContain(order.id);
  });

  it('filters by modality, a service with none being other, and sorts stat first', async () => {
    const knee = await placeOrder(catalog.knee);
    const stat = await placeOrder(catalog.chest, { priority: 'stat' });
    const xray = (await worklist('modality=xray')).items.map((each) => each.orderId);
    expect(xray).toContain(stat.id);
    expect(xray).not.toContain(knee.id);
    expect((await worklist('modality=other')).items.map((each) => each.orderId)).toContain(knee.id);
    expect((await worklist('')).items[0]?.priority).toBe('stat');
  });

  it('pages with a cursor', async () => {
    await placeOrder();
    await placeOrder();
    const first = await ok<Page<WorkItem>>(get('/radiology/worklist?limit=1'));
    expect(first.nextCursor).not.toBeNull();
    const second = await ok<Page<WorkItem>>(
      get(`/radiology/worklist?limit=1&cursor=${first.nextCursor ?? ''}`),
    );
    expect(second.items[0]?.orderId).not.toBe(first.items[0]?.orderId);
    expect(second.total).toBeUndefined();
  });

  it('refuses without the permission or the switch, and a bad cursor', async () => {
    expect(errorOf(await get('/radiology/worklist', { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await get('/radiology/worklist', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(errorOf(await get('/radiology/worklist?cursor=nope'))).toEqual([400, 'invalid_cursor']);
  });
});

describe('scheduling', () => {
  it('schedules once, with the service’s modality, and accepts the order', async () => {
    const order = await placeOrder();
    const key = randomUUID();
    const at = slot(2);
    const study = await ok<Study>(schedule(order.id, { scheduledAt: at }, { key }));
    expect(study).toMatchObject({
      orderId: order.id,
      modality: 'xray',
      scheduledAt: at,
      scheduledByName: 'Radiologist',
      version: 1,
    });
    expect(await orderStatus(order.id)).toBe('accepted');
    // A repeat answers with the same study and changes nothing.
    expect(await ok<Study>(schedule(order.id, { scheduledAt: at }, { key }))).toMatchObject({
      id: study.id,
      scheduledAt: at,
    });
    expect(await audited('imaging_study', study.id)).toEqual(['create', 'read']);
    const [event] = await events(study.id);
    expect(event?.event).toBe('imaging.scheduled');
    expect(event?.payload).toEqual({
      studyId: study.id,
      orderId: order.id,
      encounterId: expect.any(String) as string,
      patientId: patients.asha,
      serviceId: catalog.chest,
      modality: 'xray',
    });
    expect((await itemOf(order.id, 'scheduled'))?.study?.id).toBe(study.id);
  });

  it('reschedules at the version, and refuses another version or none', async () => {
    const { order, study } = await scheduled();
    expect(errorOf(await schedule(order.id, { scheduledAt: slot(3) }))).toEqual([409, 'conflict']);
    expect(
      errorOf(await schedule(order.id, { scheduledAt: slot(3), version: study.version + 1 })),
    ).toEqual([409, 'conflict']);
    const moved = await ok<Study>(
      schedule(order.id, { scheduledAt: slot(3), version: study.version }),
    );
    expect(moved).toMatchObject({ scheduledAt: slot(3), version: study.version + 1 });
    // The same slot again changes nothing.
    expect(
      await ok<Study>(schedule(order.id, { scheduledAt: slot(3), version: moved.version })),
    ).toMatchObject({ version: moved.version });
  });

  it('refuses a time off a slot, in the past or too far ahead', async () => {
    const order = await placeOrder();
    const off = new Date(new Date(slot()).getTime() + 60_000).toISOString();
    expect(errorOf(await schedule(order.id, { scheduledAt: off }))).toEqual([422, 'invalid_slot']);
    expect(errorOf(await schedule(order.id, { scheduledAt: slot(-3) }))).toEqual([
      422,
      'outside_window',
    ]);
    expect(errorOf(await schedule(order.id, { scheduledAt: slot(91 * 96) }))).toEqual([
      422,
      'outside_window',
    ]);
    // The slot under way may be booked.
    const current = new Date(Math.floor(Date.now() / SLOT) * SLOT).toISOString();
    await ok<Study>(schedule(order.id, { scheduledAt: current }));
  });

  it('gives one of two first schedules at the same moment', async () => {
    const order = await placeOrder();
    const replies = await Promise.all([
      schedule(order.id, { scheduledAt: slot() }),
      schedule(order.id, { scheduledAt: slot(1) }),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
  });

  it('unschedules back to the stage to schedule, the order staying accepted', async () => {
    const { order, study } = await scheduled();
    const off = await ok<Study>(unschedule(study));
    expect(off.scheduledAt).toBeUndefined();
    expect(await orderStatus(order.id)).toBe('accepted');
    expect((await itemOf(order.id, 'to_schedule'))?.study?.id).toBe(study.id);
    expect(errorOf(await unschedule(off))).toEqual([409, 'invalid_transition']);
    expect((await events(study.id)).map((each) => each.event)).toEqual([
      'imaging.scheduled',
      'imaging.unscheduled',
    ]);
    // Scheduled again, at its version.
    await ok<Study>(schedule(order.id, { scheduledAt: slot(1), version: off.version }));
  });

  it('does not schedule a cancelled order, nor one of another hospital', async () => {
    const order = await placeOrder();
    await ok(
      post(
        `/orders/${order.id}/cancel`,
        { version: order.version, reason: 'Duplicate' },
        { user: doctor },
      ),
    );
    expect(errorOf(await schedule(order.id, { scheduledAt: slot() }))).toEqual([
      409,
      'invalid_transition',
    ]);
    const mine = await placeOrder();
    expect(
      errorOf(
        await schedule(
          mine.id,
          { scheduledAt: slot() },
          { tenant: clinic, user: clinicRadiologist },
        ),
      ),
    ).toEqual([404, 'order_not_found']);
    expect(errorOf(await schedule(mine.id, { scheduledAt: slot() }, { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
  });
});

describe('performing', () => {
  it('performs a scheduled study once and moves the order in progress', async () => {
    const { order, study } = await scheduled();
    const done = await ok<Study>(perform(study));
    expect(done).toMatchObject({ performedByName: 'Radiologist' });
    expect(done.performedAt).toBeDefined();
    expect(await orderStatus(order.id)).toBe('in_progress');
    expect((await itemOf(order.id, 'performed'))?.stage).toBe('performed');
    expect(errorOf(await perform(done))).toEqual([409, 'invalid_transition']);
    expect(errorOf(await unschedule(done))).toEqual([409, 'invalid_transition']);
    expect(
      errorOf(await schedule(order.id, { scheduledAt: slot(), version: done.version })),
    ).toEqual([409, 'invalid_transition']);
    expect((await events(study.id)).map((each) => each.event)).toEqual([
      'imaging.scheduled',
      'imaging.performed',
    ]);
    // The doctor can no longer cancel it.
    expect(
      errorOf(
        await post(
          `/orders/${order.id}/cancel`,
          { version: 3, reason: 'Duplicate' },
          { user: doctor },
        ),
      )[0],
    ).toBe(409);
  });

  it('refuses a study never scheduled, an unscheduled one, and another version', async () => {
    const order = await placeOrder();
    expect(errorOf(await post(`/radiology/orders/${order.id}/perform`, { version: 1 }))).toEqual([
      404,
      'order_not_found',
    ]);
    const { study } = await scheduled();
    expect(errorOf(await perform({ ...study, version: study.version + 1 }))).toEqual([
      409,
      'conflict',
    ]);
    const off = await ok<Study>(unschedule(study));
    expect(errorOf(await perform(off))).toEqual([409, 'invalid_transition']);
  });

  it('leaves imaging orders to radiology while it is on', async () => {
    const order = await placeOrder();
    expect(
      errorOf(
        await post(
          `/orders/${order.id}/status`,
          { version: order.version, status: 'accepted' },
          { user: doctor },
        ),
      ),
    ).toEqual([409, 'imaging_order']);
  });
});

describe('the edges', () => {
  /** The last slot of the 90th day ahead at the hospital, and the first of the day after. */
  const windowEdge = async () => {
    const { rows } = await pool.query<{ last: Date; first: Date }>(
      `select (d.day_after at time zone t.timezone) - interval '15 minutes' as last,
              (d.day_after at time zone t.timezone) as first
       from tenants t,
         lateral (select date_trunc('day', now() at time zone t.timezone) + interval '91 days'
                  as day_after) d
       where t.id = $1`,
      [hospital.id],
    );
    return { last: rows[0]?.last.toISOString() ?? '', first: rows[0]?.first.toISOString() ?? '' };
  };

  it('takes the whole of the 90th day at the hospital, and not the day after', async () => {
    const { last, first } = await windowEdge();
    const order = await placeOrder();
    expect(errorOf(await schedule(order.id, { scheduledAt: first }))).toEqual([
      422,
      'outside_window',
    ]);
    expect((await ok<Study>(schedule(order.id, { scheduledAt: last }))).scheduledAt).toBe(last);
  });

  it('keeps a slot that has begun when it is sent again', async () => {
    const order = await placeOrder();
    const current = new Date(Math.floor(Date.now() / SLOT) * SLOT).toISOString();
    const study = await ok<Study>(schedule(order.id, { scheduledAt: current }));
    await pool.query(
      `update imaging_studies set scheduled_at = scheduled_at - interval '1 hour' where id = $1`,
      [study.id],
    );
    const past = new Date(new Date(current).getTime() - 60 * 60_000).toISOString();
    expect(
      await ok<Study>(schedule(order.id, { scheduledAt: past, version: study.version + 1 })),
    ).toMatchObject({ scheduledAt: past, version: study.version + 1 });
  });

  it('answers a repeat with the study as it is now, audited as a read, and emits once', async () => {
    const order = await placeOrder();
    const key = randomUUID();
    const at = slot();
    const study = await ok<Study>(schedule(order.id, { scheduledAt: at }, { key }));
    const done = await ok<Study>(perform(study));
    // The repeat of the first schedule answers with the study as it is now: performed.
    expect(await ok<Study>(schedule(order.id, { scheduledAt: at }, { key }))).toMatchObject({
      id: study.id,
      performedByName: 'Radiologist',
      version: done.version,
    });
    expect(await audited('imaging_study', study.id)).toEqual(['create', 'update', 'read']);
    expect((await events(study.id)).map((each) => each.event)).toEqual([
      'imaging.scheduled',
      'imaging.performed',
    ]);
    expect(await orderStatus(order.id)).toBe('in_progress');
  });

  it('refuses a change without an idempotency key', async () => {
    const order = await placeOrder();
    const reply = await app.inject({
      method: 'POST',
      url: `/radiology/orders/${order.id}/schedule`,
      headers: as(hospital.id, radiologist.id),
      payload: { scheduledAt: slot() },
    });
    expect(reply.statusCode).toBe(400);
  });

  it('reaches nothing with a narrower scope', async () => {
    const order = await placeOrder();
    const setScope = (scope: string) =>
      pool.query(
        `update role_permissions set scope = $2
         where tenant_id = $1 and permission in ('imagingStudy:read', 'imagingStudy:schedule')
           and role_id = 'radiologist'`,
        [hospital.id, scope],
      );
    await setScope('own');
    try {
      expect((await worklist('')).items).toEqual([]);
      expect(errorOf(await schedule(order.id, { scheduledAt: slot() }))).toEqual([
        404,
        'order_not_found',
      ]);
    } finally {
      await setScope('all');
    }
  });

  it('lists an order moved in progress before radiology was on as performed, and schedules it no more', async () => {
    const order = await placeOrder();
    // With radiology off, the clinical route moves imaging orders as before.
    for (const status of ['accepted', 'in_progress']) {
      await pool.query(
        `update tenant_features set enabled = false where tenant_id = $1 and feature = 'radiology'`,
        [hospital.id],
      );
      try {
        const now = await ok<{ version: number }>(get(`/orders/${order.id}`, { user: doctor }));
        await ok(
          post(`/orders/${order.id}/status`, { version: now.version, status }, { user: doctor }),
        );
      } finally {
        await pool.query(
          `update tenant_features set enabled = true where tenant_id = $1 and feature = 'radiology'`,
          [hospital.id],
        );
      }
    }
    expect((await itemOf(order.id, 'performed'))?.study).toBeUndefined();
    expect(errorOf(await schedule(order.id, { scheduledAt: slot() }))).toEqual([
      409,
      'invalid_transition',
    ]);
  });
});

describe('the database', () => {
  it('keeps studies to the hospital', async () => {
    const { study } = await scheduled();
    const seen = await asTenantSql(
      pool,
      clinic.id,
      async (sql) =>
        (await sql.query('select 1 from imaging_studies where id = $1', [study.id])).rowCount,
    );
    expect(seen).toBe(0);
    const order = await placeOrder(catalog.clinicChest, { tenant: clinic });
    const { rows } = await pool.query<{ encounter_id: string; patient_id: string }>(
      'select encounter_id, patient_id from orders where id = $1',
      [order.id],
    );
    const insert = (tenantId: string) =>
      asTenantSql(pool, tenantId, (sql) =>
        sql.query(
          `insert into imaging_studies (tenant_id, order_id, encounter_id, patient_id, service_id,
                                        modality, scheduled_at, scheduled_by)
           values ($1, $2, $3, $4, $5, 'xray', now(), $6)`,
          [
            clinic.id,
            order.id,
            rows[0]?.encounter_id,
            rows[0]?.patient_id,
            catalog.clinicChest,
            clinicRadiologist.id,
          ],
        ),
      );
    // Under the hospital, a row of the clinic is refused; the clinic itself may write it.
    await expect(insert(hospital.id)).rejects.toThrow();
    await expect(insert(clinic.id)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('never changes a performed study, nor what a study is of, and never removes one', async () => {
    const { study } = await scheduled();
    const done = await ok<Study>(perform(study));
    await asTenantSql(pool, hospital.id, async (sql) => {
      await sql.query('savepoint s');
      await expect(
        sql.query('update imaging_studies set scheduled_at = null where id = $1', [done.id]),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      await expect(
        sql.query('delete from imaging_studies where id = $1', [done.id]),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      const other = (await scheduled()).study;
      await expect(
        sql.query("update imaging_studies set modality = 'ct' where id = $1", [other.id]),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
      await expect(
        sql.query(
          'update imaging_studies set performed_at = now(), performed_by = $2, scheduled_at = null, scheduled_by = null where id = $1',
          [other.id, radiologist.id],
        ),
      ).rejects.toThrow();
      await sql.query('rollback to savepoint s');
    });
  });

  it('gives a modality to an imaging service only', async () => {
    await expect(
      pool.query(
        `insert into services (tenant_id, code, name, category, tax_class, modality)
         values ($1, 'CONS-X', 'Consultation', 'consultation', 'exempt', 'xray')`,
        [hospital.id],
      ),
    ).rejects.toThrow();
  });
});
