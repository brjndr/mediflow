import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * The operation theatre API through the real app and database: theatres, booking with the
 * exclusion constraints under concurrent requests, rescheduling and cancelling, starting and
 * completing, consumables that take stock out through the ledger, the hospital boundary,
 * permissions, audit and events.
 */

let app: FastifyInstance;
let jobs: MemoryQueue;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let surgeonUser: TestUser;
let surgeon2User: TestUser;
let pharmacist: TestUser;
let clinicAdmin: TestUser;
let surgeon: string;
let surgeon2: string;
let clinicSurgeon: string;
const patients: string[] = [];
let clinicPatient: string;
let procedureService: string;
let labService: string;
let room: Room;
let room2: Room;
let drugId: string;
let place: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Room {
  id: string;
  name: string;
  archived: boolean;
  version: number;
}
interface Surgery {
  id: string;
  roomId: string;
  surgeonId: string;
  patientId: string;
  status: string;
  version: number;
  startsAt: string;
  endsAt: string;
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
}
interface Consumable {
  id: string;
  quantity: number;
  returnedQuantity: number;
  batchId: string;
  ledgerEntryId: string;
  useId: string;
}

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `ot-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    payload: body,
  });
const patch = (url: string, body: object, options: Options = {}) =>
  app.inject({ method: 'PATCH', url, headers: headers(options), payload: body });
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

// All times are days ahead, so a booking is never in the past.
const BASE = Date.now() + 5 * 86_400_000;
const at = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();
let slot = 0;
/** A window that no other test uses: ten hours further each time. */
const nextWindow = () => {
  slot += 10;
  return { startsAt: at(slot), endsAt: at(slot + 2) };
};

let patientCursor = 0;
const nextPatient = () => patients[patientCursor++ % patients.length] as string;

const book = (body: object = {}, options: Options = {}) =>
  post(
    '/theatre/surgeries',
    {
      patientId: nextPatient(),
      roomId: room.id,
      surgeonId: surgeon,
      procedure: 'Appendectomy',
      ...nextWindow(),
      ...body,
    },
    options,
  );
const booked = async (body: object = {}, options: Options = {}) =>
  ok<Surgery>(await book(body, options), 201);

const eventsOf = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at, id',
      [hospital.id, entityId],
    )
  ).rows;
const audited = async (entityId: string) =>
  (
    await pool.query<{ action: string }>(
      "select action from audit_log where tenant_id = $1 and entity = 'surgery' and entity_id = $2 order by at",
      [hospital.id, entityId],
    )
  ).rows.map((row) => row.action);

let batchCount = 0;
async function stockIn(quantity: number, expiryDays = 400) {
  batchCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into stock_batches (tenant_id, drug_id, batch_number, expiry_date, created_by)
     values ($1, $2, $3, current_date + $4::int, $5) returning id`,
    [hospital.id, drugId, `OT${String(batchCount).padStart(4, '0')}`, expiryDays, admin.id],
  );
  const batchId = rows[0]?.id ?? '';
  await pool.query(
    `insert into stock_ledger (tenant_id, batch_id, drug_id, location_id, quantity, source, source_id, reason, actor_id)
     values ($1, $2, $3, $4, $5, 'adjustment', $6, 'opening', $7)`,
    [hospital.id, batchId, drugId, place, quantity, randomUUID(), admin.id],
  );
  return batchId;
}
const onHand = async (batchId: string) =>
  (
    await pool.query<{ on_hand: number }>(
      'select on_hand from stock_balances where batch_id = $1 and location_id = $2',
      [batchId, place],
    )
  ).rows[0]?.on_hand ?? 0;

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
const FINAL_TABLES = [
  'stock_ledger',
  'stock_balances',
  'stock_batches',
  'stock_locations',
  'drugs',
  'service_prices',
  'services',
  'doctors',
  'departments',
];
async function wipe(final = false) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query('delete from charges where tenant_id = any($1)', [tenants()]);
    await client.query('delete from encounters where tenant_id = any($1)', [tenants()]);
    for (const table of [
      'ot_note_addenda',
      'ot_notes',
      'ot_anaesthesia',
      'ot_checklist_steps',
      'ot_fitness',
      'ot_consumable_returns',
      'ot_consumables',
      'ot_bookings',
      'ot_rooms',
      ...(final ? FINAL_TABLES : []),
    ]) {
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

async function addDoctor(tenant: TestTenant, user: TestUser) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, `Surgery ${user.id.slice(0, 6)}`],
  );
  const doctor = await pool.query<{ id: string }>(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'Surgery', 15) returning id`,
    [tenant.id, user.id, rows[0]?.id],
  );
  return doctor.rows[0]?.id ?? '';
}

beforeAll(async () => {
  jobs = new MemoryQueue();
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    jobQueue: jobs,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const features = { theatre: true, patients: true, inventory: true, billing: true };
  hospital = await createTenant(pool, 'OT Hospital', { features });
  clinic = await createTenant(pool, 'OT Clinic', { features });
  closed = await createTenant(pool, 'OT Closed', { features: { theatre: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'OT Admin', { withPassword: false });
  surgeonUser = await createUser(pool, 'OT Surgeon', { withPassword: false });
  surgeon2User = await createUser(pool, 'OT Surgeon Two', { withPassword: false });
  pharmacist = await createUser(pool, 'OT Pharmacist', { withPassword: false });
  clinicAdmin = await createUser(pool, 'OT Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, surgeonUser, hospital, 'doctor');
  await addMembership(pool, surgeon2User, hospital, 'doctor');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  surgeon = await addDoctor(hospital, surgeonUser);
  surgeon2 = await addDoctor(hospital, surgeon2User);
  clinicSurgeon = await addDoctor(clinic, clinicAdmin);
  const patient = async (tenant: TestTenant, mrn: string) =>
    (
      (
        await pool.query<{ id: string }>(
          `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
           values ($1, $2, 'Ot', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
          [tenant.id, mrn],
        )
      ).rows[0] as { id: string }
    ).id;
  for (let i = 0; i < 12; i += 1) patients.push(await patient(hospital, `OT-${1000 + i}`));
  clinicPatient = await patient(clinic, 'OT-2000');
  const service = async (code: string, category: string) =>
    (
      (
        await pool.query<{ id: string }>(
          `insert into services (tenant_id, code, name, category, tax_class)
           values ($1, $2, $2, $3, 'exempt') returning id`,
          [hospital.id, code, category],
        )
      ).rows[0] as { id: string }
    ).id;
  procedureService = await service('OT-PROC', 'procedure');
  labService = await service('OT-LAB', 'lab');
  drugId = (
    (
      await pool.query<{ id: string }>(
        `insert into drugs (tenant_id, type, generic_name, form, strength, unit, schedule, tax_class, reorder_level)
         values ($1, 'medicine', 'Suture', 'other', '2-0', 'piece', 'none', 'standard', 5) returning id`,
        [hospital.id],
      )
    ).rows[0] as { id: string }
  ).id;
  place = (
    (
      await pool.query<{ id: string }>(
        "insert into stock_locations (tenant_id, name, kind) values ($1, 'OT store', 'store') returning id",
        [hospital.id],
      )
    ).rows[0] as { id: string }
  ).id;
  room = await ok<Room>(await post('/theatre/rooms', { name: 'Theatre 1' }), 201);
  room2 = await ok<Room>(await post('/theatre/rooms', { name: 'Theatre 2' }), 201);
});

afterAll(async () => {
  try {
    await wipe(true);
    await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
    await deleteUsers(
      pool,
      [admin, surgeonUser, surgeon2User, pharmacist, clinicAdmin].filter(Boolean),
    );
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('theatres', () => {
  it('adds, renames, lists and retires a theatre', async () => {
    const created = await ok<Room>(await post('/theatre/rooms', { name: 'Minor OT' }), 201);
    expect(created).toMatchObject({ name: 'Minor OT', archived: false, version: 1 });
    expect(errorOf(await post('/theatre/rooms', { name: 'minor ot' }))).toEqual([
      409,
      'name_taken',
    ]);
    const renamed = await ok<Room>(
      await patch(`/theatre/rooms/${created.id}`, { name: 'Minor Theatre', version: 1 }),
    );
    expect(renamed).toMatchObject({ name: 'Minor Theatre', version: 2 });
    expect(
      errorOf(await patch(`/theatre/rooms/${created.id}`, { name: 'Stale', version: 1 })),
    ).toEqual([409, 'version_conflict']);
    const page = await ok<Page<Room>>(await get('/theatre/rooms?limit=2'));
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const all = await ok<Page<Room>>(await get('/theatre/rooms'));
    expect(all.items.map((item) => item.name)).toContain('Minor Theatre');
    const retired = await ok<Room>(
      await patch(`/theatre/rooms/${created.id}`, { archived: true, version: 2 }),
    );
    expect(retired.archived).toBe(true);
    const visible = await ok<Page<Room>>(await get('/theatre/rooms'));
    expect(visible.items.map((item) => item.id)).not.toContain(created.id);
    const withArchived = await ok<Page<Room>>(await get('/theatre/rooms?archived=true'));
    expect(withArchived.items.map((item) => item.id)).toContain(created.id);
    expect(errorOf(await book({ roomId: created.id }))).toEqual([422, 'unknown_room']);
  });

  it('keeps a theatre in use from being retired', async () => {
    const used = await ok<Room>(await post('/theatre/rooms', { name: 'Busy OT' }), 201);
    const surgery = await booked({ roomId: used.id });
    expect(
      errorOf(await patch(`/theatre/rooms/${used.id}`, { archived: true, version: 1 })),
    ).toEqual([409, 'in_use']);
    await ok(
      await post(`/theatre/surgeries/${surgery.id}/cancel`, { reason: 'Moved', version: 1 }),
    );
    await ok(await patch(`/theatre/rooms/${used.id}`, { archived: true, version: 1 }));
  });

  it('is only for the admin to manage', async () => {
    expect(
      (await post('/theatre/rooms', { name: 'Doctor OT' }, { user: surgeonUser })).statusCode,
    ).toBe(403);
    expect((await get('/theatre/rooms', { user: surgeonUser })).statusCode).toBe(200);
  });
});

describe('booking', () => {
  it('books a surgery, audits it and emits the event with ids only', async () => {
    const surgery = await booked({ serviceId: procedureService, notes: 'Left side' });
    expect(surgery).toMatchObject({ status: 'scheduled', version: 1, roomId: room.id });
    expect(await audited(surgery.id)).toEqual(['create']);
    const events = await eventsOf(surgery.id);
    expect(events.map((row) => row.event)).toEqual(['surgery.scheduled']);
    expect(JSON.stringify(events[0]?.payload)).not.toContain('Appendectomy');
    const fetched = await ok<Surgery>(await get(`/theatre/surgeries/${surgery.id}`));
    expect(fetched.id).toBe(surgery.id);
    expect(await audited(surgery.id)).toEqual(['create', 'read']);
  });

  it('refuses a theatre, a surgeon or a patient that is already booked', async () => {
    const first = await booked({ patientId: patients[0] });
    const during = { startsAt: first.startsAt, endsAt: first.endsAt };
    expect(errorOf(await book({ ...during, surgeonId: surgeon2, patientId: patients[1] }))).toEqual(
      [409, 'room_taken'],
    );
    expect(errorOf(await book({ ...during, roomId: room2.id, patientId: patients[1] }))).toEqual([
      409,
      'surgeon_busy',
    ]);
    expect(
      errorOf(
        await book({ ...during, roomId: room2.id, surgeonId: surgeon2, patientId: patients[0] }),
      ),
    ).toEqual([409, 'patient_busy']);
    // One surgery may begin as the other ends.
    await booked({
      startsAt: first.endsAt,
      endsAt: new Date(Date.parse(first.endsAt) + 3_600_000).toISOString(),
    });
  });

  it('frees the time when a surgery is cancelled', async () => {
    const first = await booked({});
    await ok(
      await post(`/theatre/surgeries/${first.id}/cancel`, { reason: 'Not fit', version: 1 }),
    );
    await booked({ startsAt: first.startsAt, endsAt: first.endsAt });
  });

  it('lets only one of simultaneous bookings for one theatre win', async () => {
    const window = nextWindow();
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        book({
          ...window,
          patientId: patients[i],
          surgeonId: i % 2 === 0 ? surgeon : surgeon2,
        }),
      ),
    );
    const codes = results.map((response) => response.statusCode);
    expect(codes.filter((code) => code === 201)).toHaveLength(1);
    expect(codes.filter((code) => code === 409)).toHaveLength(5);
    const rows = await pool.query(
      "select 1 from ot_bookings where tenant_id = $1 and starts_at = $2 and status = 'scheduled'",
      [hospital.id, window.startsAt],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('lets only one of simultaneous bookings for one surgeon win', async () => {
    const window = nextWindow();
    const rooms = [room.id, room2.id];
    const results = await Promise.all(
      [0, 1].map((i) => book({ ...window, roomId: rooms[i], patientId: patients[i + 6] })),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('refuses what cannot be booked', async () => {
    const window = nextWindow();
    expect(errorOf(await book({ ...window, endsAt: window.startsAt }))).toEqual([
      422,
      'invalid_time',
    ]);
    expect(errorOf(await book({ startsAt: window.startsAt, endsAt: at(slot + 30) }))).toEqual([
      422,
      'invalid_time',
    ]);
    expect(
      errorOf(
        await book({
          startsAt: new Date(Date.now() - 7_200_000).toISOString(),
          endsAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ),
    ).toEqual([422, 'in_the_past']);
    expect(errorOf(await book({ ...window, roomId: randomUUID() }))).toEqual([422, 'unknown_room']);
    expect(errorOf(await book({ ...window, surgeonId: randomUUID() }))).toEqual([
      422,
      'unknown_surgeon',
    ]);
    expect(errorOf(await book({ ...window, patientId: randomUUID() }))).toEqual([
      422,
      'unknown_patient',
    ]);
    expect(errorOf(await book({ ...window, serviceId: labService }))).toEqual([
      422,
      'unknown_service',
    ]);
    expect((await book({ ...window, procedure: 'bell' })).statusCode).toBe(400);
  });

  it('books nothing twice for one idempotency key', async () => {
    const body = {
      ...nextWindow(),
      patientId: patients[2],
      roomId: room.id,
      surgeonId: surgeon,
      procedure: 'Hernia repair',
    };
    const key = fresh();
    const first = await ok<Surgery>(await post('/theatre/surgeries', body, { key }), 201);
    const again = await ok<Surgery>(await post('/theatre/surgeries', body, { key }), 201);
    expect(again.id).toBe(first.id);
    const rows = await pool.query(
      'select 1 from ot_bookings where tenant_id = $1 and starts_at = $2',
      [hospital.id, body.startsAt],
    );
    expect(rows.rowCount).toBe(1);
    const withoutKey = await app.inject({
      method: 'POST',
      url: '/theatre/surgeries',
      headers: headers(),
      payload: body,
    });
    expect(withoutKey.statusCode).toBe(400);
  });
});

describe('the schedule', () => {
  it('lists the surgeries of a range by start, with paging, and filters', async () => {
    await wipe();
    room = await ok<Room>(await post('/theatre/rooms', { name: 'Schedule OT' }), 201);
    room2 = await ok<Room>(await post('/theatre/rooms', { name: 'Schedule OT 2' }), 201);
    const first = await booked({ patientId: patients[0] });
    const second = await booked({ patientId: patients[1], surgeonId: surgeon2, roomId: room2.id });
    const third = await booked({ patientId: patients[2] });
    const range = `from=${encodeURIComponent(first.startsAt)}&to=${encodeURIComponent(third.endsAt)}`;
    const all = await ok<Page<Surgery>>(await get(`/theatre/surgeries?${range}`));
    expect(all.items.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    const one = await ok<Page<Surgery>>(await get(`/theatre/surgeries?${range}&limit=2`));
    expect(one.items).toHaveLength(2);
    const next = await ok<Page<Surgery>>(
      await get(`/theatre/surgeries?${range}&limit=2&cursor=${one.nextCursor}`),
    );
    expect(next.items.map((item) => item.id)).toEqual([third.id]);
    expect(next.nextCursor).toBeNull();
    const byRoom = await ok<Page<Surgery>>(
      await get(`/theatre/surgeries?${range}&roomId=${room2.id}`),
    );
    expect(byRoom.items.map((item) => item.id)).toEqual([second.id]);
    const bySurgeon = await ok<Page<Surgery>>(
      await get(`/theatre/surgeries?${range}&surgeonId=${surgeon2}`),
    );
    expect(bySurgeon.items.map((item) => item.id)).toEqual([second.id]);
    await ok(await post(`/theatre/surgeries/${third.id}/cancel`, { reason: 'Moved', version: 1 }));
    const live = await ok<Page<Surgery>>(await get(`/theatre/surgeries?${range}`));
    expect(live.items.map((item) => item.id)).toEqual([first.id, second.id]);
    const cancelled = await ok<Page<Surgery>>(
      await get(`/theatre/surgeries?${range}&status=cancelled`),
    );
    expect(cancelled.items.map((item) => item.id)).toEqual([third.id]);
    expect(await audited(first.id)).toContain('read');
  });

  it('refuses a range that is wrong or too wide, and a bad cursor', async () => {
    const from = at(0);
    expect(
      errorOf(
        await get(
          `/theatre/surgeries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(from)}`,
        ),
      ),
    ).toEqual([422, 'invalid_time']);
    expect(
      errorOf(
        await get(
          `/theatre/surgeries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(at(24 * 70))}`,
        ),
      ),
    ).toEqual([422, 'range_too_wide']);
    expect(
      errorOf(
        await get(
          `/theatre/surgeries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(at(24))}&cursor=nope`,
        ),
      ),
    ).toEqual([400, 'invalid_cursor']);
  });
});

describe('rescheduling and cancelling', () => {
  it('moves a scheduled surgery, checking the new time against others', async () => {
    const other = await booked({ patientId: patients[3] });
    const moving = await booked({ patientId: patients[4] });
    const clash = { startsAt: other.startsAt, endsAt: other.endsAt };
    expect(
      errorOf(await post(`/theatre/surgeries/${moving.id}/reschedule`, { ...clash, version: 1 })),
    ).toEqual([409, 'room_taken']);
    const free = nextWindow();
    const moved = await ok<Surgery>(
      await post(`/theatre/surgeries/${moving.id}/reschedule`, {
        ...free,
        roomId: room2.id,
        surgeonId: surgeon2,
        version: 1,
      }),
    );
    expect(moved).toMatchObject({ roomId: room2.id, surgeonId: surgeon2, version: 2 });
    expect(moved.startsAt).toBe(free.startsAt);
    // Its own old time never counts against it.
    const overlapping = {
      startsAt: new Date(Date.parse(free.startsAt) + 1_800_000).toISOString(),
      endsAt: new Date(Date.parse(free.endsAt) + 1_800_000).toISOString(),
    };
    await ok(
      await post(`/theatre/surgeries/${moving.id}/reschedule`, { ...overlapping, version: 2 }),
    );
    expect(
      errorOf(await post(`/theatre/surgeries/${moving.id}/reschedule`, { ...free, version: 2 })),
    ).toEqual([409, 'version_conflict']);
    expect(
      errorOf(
        await post(`/theatre/surgeries/${moving.id}/reschedule`, {
          ...free,
          roomId: randomUUID(),
          version: 3,
        }),
      ),
    ).toEqual([422, 'unknown_room']);
  });

  it('cancels a scheduled surgery once and keeps a started one', async () => {
    const surgery = await booked({});
    const cancelled = await ok<Surgery>(
      await post(`/theatre/surgeries/${surgery.id}/cancel`, {
        reason: 'Patient unwell',
        version: 1,
      }),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(
      errorOf(
        await post(`/theatre/surgeries/${surgery.id}/cancel`, { reason: 'Again', version: 2 }),
      ),
    ).toEqual([409, 'invalid_transition']);
    expect(
      errorOf(
        await post(`/theatre/surgeries/${surgery.id}/reschedule`, { ...nextWindow(), version: 2 }),
      ),
    ).toEqual([409, 'invalid_transition']);
    const events = (await eventsOf(surgery.id)).map((row) => row.event);
    expect(events).toEqual(['surgery.scheduled', 'surgery.cancelled']);
    const running = await booked({});
    await ok(await post(`/theatre/surgeries/${running.id}/start`, { version: 1 }));
    expect(
      errorOf(
        await post(`/theatre/surgeries/${running.id}/cancel`, { reason: 'Late', version: 2 }),
      ),
    ).toEqual([409, 'invalid_transition']);
  });
});

describe('performing', () => {
  it('starts then completes, once each, with events', async () => {
    const surgery = await booked({ serviceId: procedureService });
    expect(
      errorOf(await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 1 })),
    ).toEqual([409, 'invalid_transition']);
    const started = await ok<Surgery & { startedAt: string }>(
      await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }),
    );
    expect(started).toMatchObject({ status: 'in_progress', version: 2 });
    expect(started.startedAt).toBeTruthy();
    expect(errorOf(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 2 }))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect(
      errorOf(await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 1 })),
    ).toEqual([409, 'version_conflict']);
    const done = await ok<Surgery>(
      await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 2 }),
    );
    expect(done.status).toBe('completed');
    const events = await eventsOf(surgery.id);
    expect(events.map((row) => row.event)).toEqual([
      'surgery.scheduled',
      'surgery.started',
      'surgery.completed',
    ]);
    expect(events[2]?.payload).toMatchObject({
      patientId: surgery.patientId,
      surgeonId: surgeon,
      serviceId: procedureService,
    });
    expect(
      errorOf(await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 3 })),
    ).toEqual([409, 'invalid_transition']);
  });

  it('answers a repeated start from the surgery as it is', async () => {
    const surgery = await booked({});
    const key = fresh();
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }, { key }));
    const again = await ok<Surgery>(
      await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }, { key }),
    );
    expect(again.status).toBe('in_progress');
    expect(
      (await eventsOf(surgery.id)).filter((row) => row.event === 'surgery.started'),
    ).toHaveLength(1);
  });

  it('does not let the database move a finished booking', async () => {
    const surgery = await booked({});
    await ok(await post(`/theatre/surgeries/${surgery.id}/cancel`, { reason: 'x', version: 1 }));
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update ot_bookings set status = 'scheduled' where id = $1", [surgery.id]),
      ),
    ).rejects.toThrow();
  });
});

describe('consumables', () => {
  it('takes stock out through the ledger and keeps what was used', async () => {
    const batch = await stockIn(10);
    const surgery = await booked({});
    const line = { drugId, locationId: place, lines: [{ batchId: batch, quantity: 3 }] };
    expect(errorOf(await post(`/theatre/surgeries/${surgery.id}/consumables`, line))).toEqual([
      409,
      'invalid_transition',
    ]);
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }));
    const key = fresh();
    const used = await ok<Page<Consumable>>(
      await post(`/theatre/surgeries/${surgery.id}/consumables`, line, { key }),
      201,
    );
    expect(used.items).toHaveLength(1);
    expect(used.items[0]).toMatchObject({ quantity: 3, batchId: batch });
    expect(await onHand(batch)).toBe(7);
    const ledger = await pool.query<{
      source: string;
      reason: string;
      quantity: number;
      source_id: string;
    }>('select source, reason, quantity, source_id from stock_ledger where id = $1', [
      used.items[0]?.ledgerEntryId,
    ]);
    expect(ledger.rows[0]).toMatchObject({
      source: 'theatre',
      reason: 'theatre_use',
      quantity: -3,
      source_id: used.items[0]?.useId,
    });
    // A repeat takes nothing out again.
    const again = await ok<Page<Consumable>>(
      await post(`/theatre/surgeries/${surgery.id}/consumables`, line, { key }),
      201,
    );
    expect(again.items.map((item) => item.useId)).toEqual([used.items[0]?.useId]);
    expect(await onHand(batch)).toBe(7);
    // Still recorded once it is completed, and listed oldest first.
    await ok(await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 2 }));
    await ok(
      await post(`/theatre/surgeries/${surgery.id}/consumables`, {
        ...line,
        lines: [{ batchId: batch, quantity: 2 }],
      }),
      201,
    );
    expect(await onHand(batch)).toBe(5);
    const listed = await ok<Page<Consumable>>(
      await get(`/theatre/surgeries/${surgery.id}/consumables`),
    );
    expect(listed.items.map((item) => item.quantity)).toEqual([3, 2]);
    const paged = await ok<Page<Consumable>>(
      await get(`/theatre/surgeries/${surgery.id}/consumables?limit=1`),
    );
    expect(paged.nextCursor).not.toBeNull();
  });

  it('refuses more than a batch holds, an expired batch and a wrong item', async () => {
    const batch = await stockIn(2);
    const expired = await stockIn(5, -1).catch(() => null);
    const surgery = await booked({});
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }));
    const use = (lines: { batchId: string; quantity: number }[], extra: object = {}) =>
      post(`/theatre/surgeries/${surgery.id}/consumables`, {
        drugId,
        locationId: place,
        lines,
        ...extra,
      });
    expect(errorOf(await use([{ batchId: batch, quantity: 3 }]))).toEqual([
      409,
      'insufficient_stock',
    ]);
    expect(await onHand(batch)).toBe(2);
    if (expired) {
      expect(errorOf(await use([{ batchId: expired, quantity: 1 }]))).toEqual([
        409,
        'batch_expired',
      ]);
    }
    expect(errorOf(await use([{ batchId: randomUUID(), quantity: 1 }]))).toEqual([
      422,
      'unknown_batch',
    ]);
    expect(
      errorOf(await use([{ batchId: batch, quantity: 1 }], { locationId: randomUUID() })),
    ).toEqual([422, 'unknown_location']);
    expect(errorOf(await use([{ batchId: batch, quantity: 1 }], { drugId: randomUUID() }))).toEqual(
      [422, 'unknown_item'],
    );
    expect(
      errorOf(
        await use([
          { batchId: batch, quantity: 1 },
          { batchId: batch, quantity: 1 },
        ]),
      ),
    ).toEqual([422, 'duplicate_batch']);
    expect(await onHand(batch)).toBe(2);
    const none = await ok<Page<Consumable>>(
      await get(`/theatre/surgeries/${surgery.id}/consumables`),
    );
    expect(none.items).toEqual([]);
  });

  it('never oversells under simultaneous recordings', async () => {
    const batch = await stockIn(5);
    const surgery = await booked({});
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }));
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        post(`/theatre/surgeries/${surgery.id}/consumables`, {
          drugId,
          locationId: place,
          lines: [{ batchId: batch, quantity: 2 }],
        }),
      ),
    );
    const codes = results.map((response) => response.statusCode).sort();
    expect(codes).toEqual([201, 201, 409, 409]);
    expect(await onHand(batch)).toBe(1);
  });

  it('needs the inventory module', async () => {
    const off = await createTenant(pool, 'OT No Stock', {
      features: { theatre: true, patients: true, inventory: false },
    });
    try {
      await grantRoleDefaults(app, off);
      await addMembership(pool, admin, off, 'admin');
      const response = await post(
        `/theatre/surgeries/${randomUUID()}/consumables`,
        { drugId, locationId: place, lines: [{ batchId: randomUUID(), quantity: 1 }] },
        { tenant: off },
      );
      expect(errorOf(response)).toEqual([403, 'feature_disabled']);
    } finally {
      await deleteTenants(pool, [off]);
    }
  });
});

describe('boundaries', () => {
  it('keeps one hospital from seeing or touching another’s theatre', async () => {
    const mine = await booked({});
    const range = `from=${encodeURIComponent(mine.startsAt)}&to=${encodeURIComponent(mine.endsAt)}`;
    const theirs = await ok<Page<Surgery>>(
      await get(`/theatre/surgeries?${range}`, { tenant: clinic, user: clinicAdmin }),
    );
    expect(theirs.items).toEqual([]);
    expect(
      (await get(`/theatre/surgeries/${mine.id}`, { tenant: clinic, user: clinicAdmin }))
        .statusCode,
    ).toBe(404);
    expect(
      errorOf(
        await post(
          `/theatre/surgeries/${mine.id}/start`,
          { version: 1 },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'surgery_not_found']);
    const clinicRoom = await ok<Room>(
      await post('/theatre/rooms', { name: 'Theatre 1' }, { tenant: clinic, user: clinicAdmin }),
      201,
    );
    // Neither a theatre, a surgeon nor a patient of another hospital can be named.
    const window = nextWindow();
    const crossed = (body: object) =>
      post(
        '/theatre/surgeries',
        {
          procedure: 'X',
          ...window,
          patientId: clinicPatient,
          roomId: clinicRoom.id,
          surgeonId: clinicSurgeon,
          ...body,
        },
        { tenant: clinic, user: clinicAdmin },
      );
    expect(errorOf(await crossed({ roomId: room.id }))).toEqual([422, 'unknown_room']);
    expect(errorOf(await crossed({ surgeonId: surgeon }))).toEqual([422, 'unknown_surgeon']);
    expect(errorOf(await crossed({ patientId: patients[0] }))).toEqual([422, 'unknown_patient']);
    expect(
      (
        await patch(
          `/theatre/rooms/${room.id}`,
          { name: 'Hijacked', version: 1 },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
    const rows = await asTenantSql(pool, clinic.id, (client) =>
      client.query('select id from ot_bookings where id = $1', [mine.id]),
    );
    expect(rows.rowCount).toBe(0);
    // The clinic books the same hours in its own theatre: nothing is shared.
    await crossed({});
  });

  it('is off when the hospital switch is off and without the permission', async () => {
    expect(errorOf(await get('/theatre/rooms', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect((await get('/theatre/rooms', { user: pharmacist })).statusCode).toBe(403);
    expect((await book({}, { user: pharmacist })).statusCode).toBe(403);
    const surgery = await booked({});
    expect(
      (await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }, { user: pharmacist }))
        .statusCode,
    ).toBe(403);
    expect((await book({}, { user: surgeonUser })).statusCode).toBe(201);
  });
});

describe('the peri-operative record', () => {
  const STEPS = [
    ['consent_confirmed', 'site_marked', 'fasting_confirmed'],
    ['identity_confirmed', 'anaesthesia_check_done', 'allergies_checked'],
  ];
  interface Periop {
    surgeryId: string;
    checklist: { step: string; completedBy: string; completedByName: string }[];
    fitness: { status: string; assessedBy: string; assessedByName: string } | null;
    anaesthesia: { technique: string; signedAt?: string; signedByName?: string } | null;
  }
  const put = (url: string, body: object, options: Options = {}) =>
    app.inject({ method: 'PUT', url, headers: headers(options), payload: body });
  const step = (id: string, name: string, options: Options = {}) =>
    post(`/theatre/surgeries/${id}/checklist/${name}`, {}, options);
  const anaesthesia = { technique: 'general', asaClass: 2, drugs: 'Propofol 100 mg' };

  it('starts empty and is read as a patient record read', async () => {
    const surgery = await booked({});
    const empty = await ok<Periop>(await get(`/theatre/surgeries/${surgery.id}/periop`));
    expect(empty).toEqual({
      surgeryId: surgery.id,
      checklist: [],
      fitness: null,
      anaesthesia: null,
    });
    expect(await audited(surgery.id)).toContain('read');
    expect(errorOf(await get(`/theatre/surgeries/${randomUUID()}/periop`))).toEqual([
      404,
      'surgery_not_found',
    ]);
  });

  it('replaces the fitness assessment and names the assessor', async () => {
    const surgery = await booked({});
    const url = `/theatre/surgeries/${surgery.id}/fitness`;
    await ok(await put(url, { status: 'conditional', notes: 'Stop aspirin' }));
    const record = await ok<Periop>(await put(url, { status: 'fit' }, { user: surgeonUser }));
    expect(record.fitness).toMatchObject({
      status: 'fit',
      assessedBy: surgeonUser.id,
      assessedByName: 'OT Surgeon',
    });
    expect(errorOf(await put(url, { status: 'maybe' }))[0]).toBe(400);
    expect((await audited(surgery.id)).filter((action) => action === 'update')).toHaveLength(2);
  });

  it('completes steps in phase order, once, signed by the server', async () => {
    const surgery = await booked({});
    expect(errorOf(await step(surgery.id, 'identity_confirmed'))).toEqual([
      409,
      'phase_incomplete',
    ]);
    expect((await step(surgery.id, 'nonsense')).statusCode).toBe(400);
    for (const name of STEPS[0] as string[]) await ok(await step(surgery.id, name));
    const first = await ok<Periop>(
      await step(surgery.id, 'identity_confirmed', { user: surgeonUser }),
    );
    const entry = first.checklist.find((c) => c.step === 'identity_confirmed');
    expect(entry).toMatchObject({ completedBy: surgeonUser.id, completedByName: 'OT Surgeon' });
    // A repeat by someone else, with a new key, answers with the first entry and adds nothing.
    const again = await ok<Periop>(await step(surgery.id, 'identity_confirmed'));
    expect(again.checklist).toHaveLength(4);
    expect(again.checklist.find((c) => c.step === 'identity_confirmed')).toEqual(entry);
    expect(errorOf(await step(surgery.id, 'counts_correct'))).toEqual([409, 'phase_incomplete']);
    const events = (await eventsOf(surgery.id)).filter(
      (row) => row.event === 'surgery.checklist_step_completed',
    );
    expect(events).toHaveLength(4);
    expect(events[3]?.payload).toMatchObject({
      patientId: surgery.patientId,
      step: 'identity_confirmed',
    });
  });

  it('does a step once for one idempotency key', async () => {
    const surgery = await booked({});
    const key = fresh();
    await ok(await step(surgery.id, 'consent_confirmed', { key }));
    await ok(await step(surgery.id, 'consent_confirmed', { key }));
    expect(
      (await eventsOf(surgery.id)).filter((r) => r.event === 'surgery.checklist_step_completed'),
    ).toHaveLength(1);
  });

  it('keeps a draft until it is signed once, then never changes it', async () => {
    const surgery = await booked({});
    const base = `/theatre/surgeries/${surgery.id}/anaesthesia`;
    expect(errorOf(await post(`${base}/sign`, {}))).toEqual([404, 'anaesthesia_not_found']);
    await ok(await put(base, anaesthesia));
    const draft = await ok<Periop>(
      await put(base, { ...anaesthesia, technique: 'spinal', asaClass: 3 }),
    );
    expect(draft.anaesthesia).toMatchObject({ technique: 'spinal' });
    expect(draft.anaesthesia?.signedAt).toBeUndefined();
    const signed = await ok<Periop>(await post(`${base}/sign`, {}, { user: surgeonUser }));
    expect(signed.anaesthesia).toMatchObject({ technique: 'spinal', signedByName: 'OT Surgeon' });
    expect(signed.anaesthesia?.signedAt).toBeTruthy();
    expect(errorOf(await put(base, anaesthesia))).toEqual([409, 'already_signed']);
    expect(errorOf(await post(`${base}/sign`, {}))).toEqual([409, 'already_signed']);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update ot_anaesthesia set notes = 'x' where booking_id = $1", [surgery.id]),
      ),
    ).rejects.toThrow();
  });

  it('is read-only once the surgery is completed or cancelled', async () => {
    const done = await booked({});
    await ok(await post(`/theatre/surgeries/${done.id}/start`, { version: 1 }));
    await ok(await step(done.id, 'consent_confirmed'));
    await ok(await post(`/theatre/surgeries/${done.id}/complete`, { version: 2 }));
    const cancelled = await booked({});
    await ok(await post(`/theatre/surgeries/${cancelled.id}/cancel`, { reason: 'x', version: 1 }));
    for (const id of [done.id, cancelled.id]) {
      expect(errorOf(await put(`/theatre/surgeries/${id}/fitness`, { status: 'fit' }))).toEqual([
        409,
        'invalid_state',
      ]);
      expect(errorOf(await step(id, 'site_marked'))).toEqual([409, 'invalid_state']);
      expect(errorOf(await put(`/theatre/surgeries/${id}/anaesthesia`, anaesthesia))).toEqual([
        409,
        'invalid_state',
      ]);
      await ok(await get(`/theatre/surgeries/${id}/periop`));
    }
    const record = await ok<Periop>(await get(`/theatre/surgeries/${done.id}/periop`));
    expect(record.checklist).toHaveLength(1);
  });

  it('needs the right permission and the module, and stays inside the hospital', async () => {
    const surgery = await booked({});
    const url = `/theatre/surgeries/${surgery.id}`;
    await ok(await put(`${url}/fitness`, { status: 'fit' }));
    await ok(await step(surgery.id, 'consent_confirmed'));
    expect((await get(`${url}/periop`, { user: pharmacist })).statusCode).toBe(403);
    expect((await put(`${url}/fitness`, { status: 'fit' }, { user: pharmacist })).statusCode).toBe(
      403,
    );
    expect((await step(surgery.id, 'site_marked', { user: pharmacist })).statusCode).toBe(403);
    expect((await get(`${url}/periop`, { tenant: closed })).statusCode).toBe(403);
    // Another hospital cannot see or change it.
    const other = { tenant: clinic, user: clinicAdmin };
    expect(errorOf(await get(`${url}/periop`, other))).toEqual([404, 'surgery_not_found']);
    expect(errorOf(await put(`${url}/fitness`, { status: 'unfit' }, other))).toEqual([
      404,
      'surgery_not_found',
    ]);
    expect(errorOf(await step(surgery.id, 'site_marked', other))).toEqual([
      404,
      'surgery_not_found',
    ]);
    for (const table of ['ot_fitness', 'ot_checklist_steps', 'ot_anaesthesia']) {
      const rows = await asTenantSql(pool, clinic.id, (client) =>
        client.query(`select 1 from ${table}`),
      );
      expect(rows.rowCount).toBe(0);
    }
  });
});

describe('the operation note, the visit and the charges', () => {
  interface Operation {
    surgeryId: string;
    encounterId: string | null;
    note: { procedureDone: string; signedAt?: string; signedByName?: string } | null;
    addenda: { text: string; addedByName: string }[];
  }
  interface ChargeRow {
    source: string;
    source_ref: string;
    quantity: number;
    unit_price_minor: string;
    service_id: string | null;
  }
  const put = (url: string, body: object, options: Options = {}) =>
    app.inject({ method: 'PUT', url, headers: headers(options), payload: body });
  const note = { procedureDone: 'Laparoscopic appendectomy', findings: 'Inflamed appendix' };
  const addEncounter = async (tenant: TestTenant, patientId: string, status = 'open') =>
    (
      await pool.query<{ id: string }>(
        `insert into encounters (tenant_id, patient_id, type, opened_by, status, cancel_reason, ended_at, ended_by)
         values ($1, $2, 'ipd', $3, $4, $5, $6, $7) returning id`,
        [
          tenant.id,
          patientId,
          admin.id,
          status,
          status === 'cancelled' ? 'Entered in error' : null,
          status === 'open' ? null : new Date(),
          status === 'open' ? null : admin.id,
        ],
      )
    ).rows[0]?.id ?? '';
  const chargesOf = async (encounterId: string) => {
    await app.events.dispatch();
    await jobs.drain();
    return (
      await pool.query<ChargeRow>(
        'select source, source_ref, quantity, unit_price_minor::text, service_id from charges where encounter_id = $1 order by source_ref',
        [encounterId],
      )
    ).rows;
  };

  it('keeps a draft, signs it once and corrects it only by addenda', async () => {
    const surgery = await booked({});
    const url = `/theatre/surgeries/${surgery.id}/operation-note`;
    expect(errorOf(await put(url, note))).toEqual([409, 'invalid_state']);
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }));
    const empty = await ok<Operation>(await get(url));
    expect(empty).toMatchObject({
      surgeryId: surgery.id,
      encounterId: null,
      note: null,
      addenda: [],
    });
    expect(errorOf(await post(`${url}/sign`, {}))).toEqual([404, 'note_not_found']);
    expect(errorOf(await post(`${url}/addenda`, { text: 'Early' }))).toEqual([409, 'not_signed']);
    await ok(await put(url, note));
    const changed = await ok<Operation>(await put(url, { ...note, bloodLossMl: 50 }));
    expect(changed.note).toMatchObject({ procedureDone: note.procedureDone });
    expect((await put(url, { procedureDone: '' })).statusCode).toBe(400);
    const key = fresh();
    const signed = await ok<Operation>(await post(`${url}/sign`, {}, { key }));
    expect(signed.note?.signedAt).toBeDefined();
    expect(signed.note?.signedByName).toBe('OT Admin');
    expect((await post(`${url}/sign`, {}, { key })).statusCode).toBe(200);
    expect(errorOf(await post(`${url}/sign`, {}))).toEqual([409, 'already_signed']);
    expect(errorOf(await put(url, note))).toEqual([409, 'already_signed']);
    const withAddendum = await ok<Operation>(
      await post(`${url}/addenda`, { text: 'Drain removed' }),
    );
    expect(withAddendum.addenda).toMatchObject([
      { text: 'Drain removed', addedByName: 'OT Admin' },
    ]);
    await expect(
      pool.query("update ot_notes set findings = 'x' where booking_id = $1", [surgery.id]),
    ).rejects.toThrow(/never changed/);
    await ok(await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 2 }));
    await ok(await post(`${url}/addenda`, { text: 'Second' }));
    expect(await audited(surgery.id)).toContain('read');
    const events = await pool.query<{ p: string }>(
      'select payload::text as p from outbox where entity_id = $1',
      [surgery.id],
    );
    expect(events.rows.map((row) => row.p).join()).not.toContain('appendix');
  });

  it('links an open visit of the patient and charges the procedure and consumables to it', async () => {
    const surgery = await booked({ serviceId: procedureService });
    const encounter = await addEncounter(hospital, surgery.patientId);
    await pool.query(
      `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
       select $1, $2, id, 250000, current_date - 10 from price_lists where tenant_id = $1 and standard
       on conflict do nothing`,
      [hospital.id, procedureService],
    );
    const link = `/theatre/surgeries/${surgery.id}/encounter`;
    expect(errorOf(await put(link, { encounterId: randomUUID() }))).toEqual([
      422,
      'unknown_encounter',
    ]);
    const otherPatient = patients.find((id) => id !== surgery.patientId) as string;
    const other = await addEncounter(hospital, otherPatient);
    expect(errorOf(await put(link, { encounterId: other }))).toEqual([422, 'unknown_encounter']);
    const finished = await addEncounter(hospital, surgery.patientId, 'closed');
    expect(errorOf(await put(link, { encounterId: finished }))).toEqual([422, 'unknown_encounter']);
    const linked = await ok<Operation>(await put(link, { encounterId: encounter }));
    expect(linked.encounterId).toBe(encounter);

    const batch = await stockIn(10);
    await pool.query('update stock_batches set mrp_minor = 1500 where id = $1', [batch]);
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 2 }));
    const line = { drugId, locationId: place, lines: [{ batchId: batch, quantity: 4 }] };
    await ok(await post(`/theatre/surgeries/${surgery.id}/consumables`, line), 201);
    expect(await onHand(batch)).toBe(6);
    let charges = await chargesOf(encounter);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ source: 'dispense', quantity: 4, unit_price_minor: '1500' });
    await ok(await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 3 }));
    charges = await chargesOf(encounter);
    expect(charges.map((row) => row.source).sort()).toEqual(['dispense', 'procedure']);
    expect(charges.find((row) => row.source === 'procedure')).toMatchObject({
      source_ref: `surgery:${surgery.id}`,
      service_id: procedureService,
      unit_price_minor: '250000',
    });
    expect(errorOf(await put(link, { encounterId: encounter }))).toEqual([409, 'invalid_state']);
    expect(await chargesOf(encounter)).toHaveLength(2);
  });

  it('brings consumables back to stock and reverses the charge while it is not invoiced (#892)', async () => {
    const surgery = await booked({});
    const encounter = await addEncounter(hospital, surgery.patientId);
    await ok(await put(`/theatre/surgeries/${surgery.id}/encounter`, { encounterId: encounter }));
    const batch = await stockIn(10);
    await pool.query('update stock_batches set mrp_minor = 900 where id = $1', [batch]);
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 2 }));
    const used = await ok<Page<Consumable>>(
      await post(`/theatre/surgeries/${surgery.id}/consumables`, {
        drugId,
        locationId: place,
        lines: [{ batchId: batch, quantity: 4 }],
      }),
      201,
    );
    const consumable = used.items[0]?.id as string;
    const url = `/theatre/surgeries/${surgery.id}/consumables/${consumable}/return`;
    expect(await chargesOf(encounter)).toHaveLength(1);
    expect(await onHand(batch)).toBe(6);

    expect(errorOf(await post(url, { quantity: 5, reason: 'Unused' }, { key: fresh() }))).toEqual([
      409,
      'over_return',
    ]);
    expect(
      errorOf(
        await post(
          `/theatre/surgeries/${surgery.id}/consumables/${randomUUID()}/return`,
          { quantity: 1, reason: 'Unused' },
          { key: fresh() },
        ),
      ),
    ).toEqual([404, 'consumable_not_found']);

    // A part comes back: stock rises, the charge is flagged for the desk, not changed.
    const key = fresh();
    const part = await ok<Page<Consumable>>(
      await post(url, { quantity: 1, reason: 'Unopened' }, { key }),
      201,
    );
    expect(part.items[0]).toMatchObject({ quantity: 4, returnedQuantity: 1 });
    await ok(await post(url, { quantity: 1, reason: 'Unopened' }, { key }), 201);
    expect(await onHand(batch)).toBe(7);
    const ledger = await pool.query<{ source: string; reason: string; quantity: number }>(
      "select source, reason, quantity from stock_ledger where batch_id = $1 and reason = 'theatre_return'",
      [batch],
    );
    expect(ledger.rows).toEqual([{ source: 'theatre', reason: 'theatre_return', quantity: 1 }]);
    const flagged = async () =>
      (
        await pool.query<{ status: string; flag: string | null }>(
          'select status, flag from charges where encounter_id = $1',
          [encounter],
        )
      ).rows;
    await chargesOf(encounter);
    expect(await flagged()).toEqual([{ status: 'pending', flag: 'return_review' }]);

    // The rest comes back before any invoice: the charge is voided.
    await ok(await post(url, { quantity: 3, reason: 'Unused' }, { key: fresh() }), 201);
    expect(await onHand(batch)).toBe(10);
    await chargesOf(encounter);
    expect(await flagged()).toEqual([{ status: 'void', flag: 'return_review' }]);
    expect(await eventsOf(surgery.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'surgery.consumables_returned' })]),
    );
    const returns = await pool.query(
      'select 1 from ot_consumable_returns where consumable_id = $1',
      [consumable],
    );
    expect(returns.rowCount).toBe(2);
    expect(
      errorOf(
        await post(
          url,
          { quantity: 1, reason: 'Unused' },
          { key: fresh(), tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'surgery_not_found']);
  });

  it('leaves an invoiced charge as it is and flags it for a credit when units come back (#892)', async () => {
    const surgery = await booked({});
    const encounter = await addEncounter(hospital, surgery.patientId);
    await ok(await put(`/theatre/surgeries/${surgery.id}/encounter`, { encounterId: encounter }));
    const batch = await stockIn(5);
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 2 }));
    const used = await ok<Page<Consumable>>(
      await post(`/theatre/surgeries/${surgery.id}/consumables`, {
        drugId,
        locationId: place,
        lines: [{ batchId: batch, quantity: 2 }],
      }),
      201,
    );
    await chargesOf(encounter);
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = 'replica'");
      await client.query(
        "update charges set status = 'invoiced', invoice_id = $2 where encounter_id = $1",
        [encounter, randomUUID()],
      );
    } finally {
      await client.query("set session_replication_role = 'origin'");
      client.release();
    }
    await ok(
      await post(
        `/theatre/surgeries/${surgery.id}/consumables/${used.items[0]?.id}/return`,
        { quantity: 2, reason: 'Wrong size' },
        { key: fresh() },
      ),
      201,
    );
    await chargesOf(encounter);
    const rows = await pool.query('select status, flag from charges where encounter_id = $1', [
      encounter,
    ]);
    expect(rows.rows).toEqual([{ status: 'invoiced', flag: 'return_review' }]);
    expect(await onHand(batch)).toBe(5);
  });

  it('posts no charge for a surgery with no visit', async () => {
    const surgery = await booked({ serviceId: procedureService });
    const batch = await stockIn(5);
    await ok(await post(`/theatre/surgeries/${surgery.id}/start`, { version: 1 }));
    await ok(
      await post(`/theatre/surgeries/${surgery.id}/consumables`, {
        drugId,
        locationId: place,
        lines: [{ batchId: batch, quantity: 1 }],
      }),
      201,
    );
    await ok(await post(`/theatre/surgeries/${surgery.id}/complete`, { version: 2 }));
    await app.events.dispatch();
    await jobs.drain();
    const rows = await pool.query('select 1 from charges where source_ref like $1', [
      `%${surgery.id}%`,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('needs the right permission and the module, and stays inside the hospital', async () => {
    const surgery = await booked({});
    const url = `/theatre/surgeries/${surgery.id}`;
    await ok(await post(`${url}/start`, { version: 1 }));
    await ok(await put(`${url}/operation-note`, note));
    expect((await get(`${url}/operation-note`, { user: pharmacist })).statusCode).toBe(403);
    expect((await put(`${url}/operation-note`, note, { user: pharmacist })).statusCode).toBe(403);
    expect((await post(`${url}/operation-note/sign`, {}, { user: pharmacist })).statusCode).toBe(
      403,
    );
    expect((await get(`${url}/operation-note`, { tenant: closed })).statusCode).toBe(403);
    const other = { tenant: clinic, user: clinicAdmin };
    expect(errorOf(await get(`${url}/operation-note`, other))).toEqual([404, 'surgery_not_found']);
    expect(errorOf(await put(`${url}/operation-note`, note, other))).toEqual([
      404,
      'surgery_not_found',
    ]);
    expect(errorOf(await put(`${url}/encounter`, { encounterId: randomUUID() }, other))).toEqual([
      404,
      'surgery_not_found',
    ]);
    for (const table of ['ot_notes', 'ot_note_addenda']) {
      const rows = await asTenantSql(pool, clinic.id, (client) =>
        client.query(`select 1 from ${table}`),
      );
      expect(rows.rowCount).toBe(0);
    }
  });
});
