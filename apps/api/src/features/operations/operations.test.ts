import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireBloodUnits, expireBloodUnitsEverywhere } from './expiry.js';
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
 * The operations API through the real app and database: rosters, the blood bank and its state
 * machine, ambulances and trips, and bed cleaning tasks; the hospital boundary, permissions,
 * audit, events and the database's own refusals.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let jobs: MemoryQueue;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let nurse: TestUser;
let labTech: TestUser;
let pharmacist: TestUser;
let clinicAdmin: TestUser;
let department: string;
let ward: string;
const beds: string[] = [];
let patientId: string;
let clinicPatientId: string;
let clinicBedId: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
}

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `ops-key-${String(++keys).padStart(6, '0')}`;
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

const hour = 3_600_000;
const base = Date.parse('2031-03-01T00:00:00Z');
const at = (hours: number) => new Date(base + hours * hour).toISOString();

const eventsOf = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at, id',
      [hospital.id, entityId],
    )
  ).rows;
const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
const TABLES = [
  'roster_shift_templates',
  'roster_leaves',
  'roster_shifts',
  'blood_unit_events',
  'blood_units',
  'ambulance_trip_crew',
  'ambulance_trips',
  'ambulances',
  'cleaning_tasks',
];
async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of TABLES) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query(
      "update beds set status = 'available', blocked_reason = null where tenant_id = any($1)",
      [tenants()],
    );
    await client.query('delete from outbox where tenant_id = any($1)', [tenants()]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const allOn = {
  roster: true,
  bloodbank: true,
  ambulance: true,
  housekeeping: true,
  wards: true,
  patients: true,
  departments: true,
};

beforeAll(async () => {
  jobs = new MemoryQueue();
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    jobQueue: jobs,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Ops Hospital', { features: allOn });
  clinic = await createTenant(pool, 'Ops Clinic', { features: allOn });
  closed = await createTenant(pool, 'Ops Closed', {
    features: { roster: false, bloodbank: false, ambulance: false, housekeeping: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Ops Admin', { withPassword: false });
  nurse = await createUser(pool, 'Ops Nurse', { withPassword: false });
  labTech = await createUser(pool, 'Ops Lab', { withPassword: false });
  pharmacist = await createUser(pool, 'Ops Pharmacist', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Ops Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, labTech, hospital, 'lab_technician');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');

  const one = async (sql: string, params: unknown[]) =>
    ((await pool.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;
  department = await one('insert into departments (tenant_id, name) values ($1, $2) returning id', [
    hospital.id,
    'Medicine',
  ]);
  const structure = async (tenant: TestTenant, count: number) => {
    const category = await one(
      'insert into bed_categories (tenant_id, name) values ($1, $2) returning id',
      [tenant.id, 'General'],
    );
    const wardId = await one(
      'insert into wards (tenant_id, code, name) values ($1, $2, $3) returning id',
      [tenant.id, 'W1', 'Ward One'],
    );
    const room = await one(
      'insert into rooms (tenant_id, ward_id, name) values ($1, $2, $3) returning id',
      [tenant.id, wardId, 'Room 1'],
    );
    const ids: string[] = [];
    for (let n = 1; n <= count; n += 1) {
      ids.push(
        await one(
          'insert into beds (tenant_id, ward_id, room_id, number, bed_category_id) values ($1, $2, $3, $4, $5) returning id',
          [tenant.id, wardId, room, `B${n}`, category],
        ),
      );
    }
    return { wardId, ids };
  };
  const made = await structure(hospital, 4);
  ward = made.wardId;
  beds.push(...made.ids);
  clinicBedId = (await structure(clinic, 1)).ids[0] as string;
  const patient = (tenant: TestTenant, mrn: string) =>
    one(
      `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
       values ($1, $2, 'Ops', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
      [tenant.id, mrn],
    );
  patientId = await patient(hospital, 'OP-0000001');
  clinicPatientId = await patient(clinic, 'OP-0000002');
}, 60_000); // builds a whole app and migrated tenants: over the 10 s default on a fresh database (#631)

afterAll(async () => {
  try {
    await wipe();
    for (const table of [
      'beds',
      'rooms',
      'wards',
      'bed_categories',
      'encounters',
      'services',
      'patients',
      'departments',
    ]) {
      await pool.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await deleteUsers(pool, [admin, nurse, labTech, pharmacist, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

// --- roster ------------------------------------------------------------------------------------

interface Shift {
  id: string;
  userId: string;
  userName: string;
  status: string;
  version: number;
  departmentName?: string;
}
const shift = (more: object = {}, options: Options = {}) =>
  post(
    '/roster/shifts',
    {
      userId: nurse.id,
      shiftKind: 'morning',
      startsAt: at(8),
      endsAt: at(16),
      ...more,
    },
    options,
  );

describe('the roster', () => {
  it('puts someone on duty: audited, an event, with the department', async () => {
    await wipe();
    const made = await ok<Shift>(await shift({ departmentId: department }), 201);
    expect(made).toMatchObject({
      userName: 'Ops Nurse',
      status: 'scheduled',
      departmentName: 'Medicine',
      version: 1,
    });
    expect(await audited('roster_shift', made.id)).toEqual(['create']);
    const events = await eventsOf(made.id);
    expect(events.map((event) => event.event)).toEqual(['roster.shift_scheduled']);
    expect(events[0]?.payload).toMatchObject({ userId: nurse.id, shiftKind: 'morning' });
  });

  it('refuses an overlap for one person, and a bad period', async () => {
    await wipe();
    await ok(await shift(), 201);
    expect(errorOf(await shift({ startsAt: at(15), endsAt: at(20) }))).toEqual([
      409,
      'shift_overlap',
    ]);
    // Back to back is fine, and another person may work the same hours.
    await ok(await shift({ startsAt: at(16), endsAt: at(20) }), 201);
    await ok(await shift({ userId: labTech.id }), 201);
    expect(errorOf(await shift({ startsAt: at(8), endsAt: at(8) }))).toEqual([
      422,
      'invalid_period',
    ]);
    expect(errorOf(await shift({ startsAt: at(0), endsAt: at(30) }))).toEqual([
      422,
      'invalid_period',
    ]);
  });

  it('refuses people and departments of another hospital', async () => {
    await wipe();
    expect(errorOf(await shift({ userId: clinicAdmin.id }))).toEqual([422, 'unknown_user']);
    expect(errorOf(await shift({ userId: 'nope' }))).toEqual([422, 'unknown_user']);
    const other = (
      await pool.query<{ id: string }>(
        'insert into departments (tenant_id, name) values ($1, $2) returning id',
        [clinic.id, 'Other'],
      )
    ).rows[0]?.id;
    expect(errorOf(await shift({ departmentId: other }))).toEqual([422, 'unknown_department']);
    await pool.query('delete from departments where id = $1', [other]);
  });

  it('lists a window, and a hospital sees only its own shifts', async () => {
    await wipe();
    await ok(await shift(), 201);
    await ok(await shift({ startsAt: at(32), endsAt: at(40) }), 201);
    const day = await ok<Page<Shift>>(
      await get(`/roster/shifts?from=${at(0)}&to=${at(24)}`, { user: pharmacist }),
    );
    expect(day.items).toHaveLength(1);
    const paged = await ok<Page<Shift>>(await get('/roster/shifts?limit=1'));
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).not.toBeNull();
    const next = await ok<Page<Shift>>(
      await get(`/roster/shifts?limit=1&cursor=${paged.nextCursor}`),
    );
    expect(next.items[0]?.id).not.toBe(paged.items[0]?.id);
    expect(
      (await ok<Page<Shift>>(await get('/roster/shifts', { tenant: clinic, user: clinicAdmin })))
        .items,
    ).toEqual([]);
    expect(errorOf(await get('/roster/shifts?cursor=garbage'))).toEqual([400, 'invalid_cursor']);
  });

  it('cancels once, at the version read, and frees the time', async () => {
    await wipe();
    const made = await ok<Shift>(await shift(), 201);
    expect(errorOf(await post(`/roster/shifts/${made.id}/cancel`, { version: 9 }))).toEqual([
      409,
      'conflict',
    ]);
    const cancelled = await ok<Shift>(
      await post(`/roster/shifts/${made.id}/cancel`, { version: 1 }),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(errorOf(await post(`/roster/shifts/${made.id}/cancel`, { version: 2 }))).toEqual([
      409,
      'invalid_transition',
    ]);
    await ok(await shift(), 201);
    expect((await eventsOf(made.id)).map((event) => event.event)).toContain(
      'roster.shift_cancelled',
    );
    expect(errorOf(await post('/roster/shifts/not-an-id/cancel', { version: 1 }))).toEqual([
      404,
      'shift_not_found',
    ]);
    const hidden = await ok<Page<Shift>>(await get('/roster/shifts'));
    expect(hidden.items).toHaveLength(1);
    const all = await ok<Page<Shift>>(await get('/roster/shifts?includeCancelled=true'));
    expect(all.items).toHaveLength(2);
  });

  it('is for those with the permission, and the hospital with the module on', async () => {
    await wipe();
    expect((await shift({}, { user: nurse })).statusCode).toBe(403);
    expect((await get('/roster/shifts', { user: pharmacist })).statusCode).toBe(200);
    expect(errorOf(await get('/roster/shifts', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    const made = await ok<Shift>(await shift(), 201);
    expect(
      (
        await post(
          `/roster/shifts/${made.id}/cancel`,
          { version: 1 },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('repeats an Idempotency-Key without a second shift', async () => {
    await wipe();
    const key = fresh();
    const first = await ok<Shift>(await shift({}, { key }), 201);
    const again = await ok<Shift>(await shift({}, { key }), 201);
    expect(again.id).toBe(first.id);
    const { rows } = await pool.query('select 1 from roster_shifts where tenant_id = $1', [
      hospital.id,
    ]);
    expect(rows).toHaveLength(1);
  });
});

// --- templates, copied weeks and swaps (#592) ----------------------------------------------------

interface Template {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  departmentName?: string;
  active: boolean;
  version: number;
}
interface CopyResult {
  copied: number;
  skipped: { shiftId: string; reason: string }[];
}
const template = (more: object = {}, options: Options = {}) =>
  post(
    '/roster/templates',
    { name: 'Early', shiftKind: 'morning', startTime: '06:30', endTime: '14:30', ...more },
    options,
  );

describe('shift templates', () => {
  it('are kept per hospital, listed, retired once and audited', async () => {
    await wipe();
    const made = await ok<Template>(await template({ departmentId: department }), 201);
    expect(made).toMatchObject({ name: 'Early', departmentName: 'Medicine', active: true });
    expect(await audited('roster_shift_template', made.id)).toEqual(['create']);
    expect(errorOf(await template({ name: 'early' }))).toEqual([409, 'template_exists']);
    expect(errorOf(await template({ name: 'Same', endTime: '06:30' }))).toEqual([
      422,
      'invalid_period',
    ]);
    expect(errorOf(await template({ name: 'X', departmentId: 'nope' }))).toEqual([
      422,
      'unknown_department',
    ]);
    // A night template runs into the next day.
    await ok(
      await template({ name: 'Night', shiftKind: 'night', startTime: '22:00', endTime: '06:00' }),
      201,
    );
    // Another hospital has its own list, and may reuse the name.
    expect(
      (
        await ok<Page<Template>>(
          await get('/roster/templates', { tenant: clinic, user: clinicAdmin }),
        )
      ).items,
    ).toEqual([]);
    await ok(await template({}, { tenant: clinic, user: clinicAdmin }), 201);
    expect(errorOf(await post(`/roster/templates/${made.id}/retire`, { version: 5 }))).toEqual([
      409,
      'conflict',
    ]);
    const retired = await ok<Template>(
      await post(`/roster/templates/${made.id}/retire`, { version: 1 }),
    );
    expect(retired.active).toBe(false);
    expect(errorOf(await post(`/roster/templates/${made.id}/retire`, { version: 2 }))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect((await ok<Page<Template>>(await get('/roster/templates'))).items).toHaveLength(1);
    expect(
      (await ok<Page<Template>>(await get('/roster/templates?includeInactive=true'))).items,
    ).toHaveLength(2);
    // The name is free again once its template is retired.
    await ok(await template(), 201);
    expect(
      errorOf(
        await post(
          `/roster/templates/${made.id}/retire`,
          { version: 2 },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'template_not_found']);
  });

  it('are read by staff and managed by those who manage the roster', async () => {
    expect((await template({ name: 'Nurse try' }, { user: nurse })).statusCode).toBe(403);
    expect((await get('/roster/templates', { user: nurse })).statusCode).toBe(200);
    expect(errorOf(await get('/roster/templates', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('copying a week', () => {
  const copy = (more: object = {}, options: Options = {}) =>
    post('/roster/copy-week', { fromStart: at(0), toStart: at(168), ...more }, options);

  it('fills the next weeks, skips what clashes, and writes an event for each shift', async () => {
    await wipe();
    await ok(await shift({ departmentId: department }), 201);
    await ok(await shift({ userId: labTech.id, startsAt: at(30), endsAt: at(38) }), 201);
    // The nurse is already on duty in the next week at the same time.
    await ok(await shift({ startsAt: at(168 + 12), endsAt: at(168 + 14) }), 201);
    // Outside the source week: not copied.
    await ok(await shift({ startsAt: at(200), endsAt: at(208) }), 201);
    const result = await ok<CopyResult>(await copy({ weeks: 2 }));
    expect(result.copied).toBe(3);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('shift_overlap');
    const { rows } = await pool.query<{ starts_at: Date; department_id: string | null }>(
      "select starts_at, department_id from roster_shifts where tenant_id = $1 and user_id = $2 and status = 'scheduled' order by starts_at",
      [hospital.id, nurse.id],
    );
    const later = rows.find((row) => row.starts_at.toISOString() === at(8 + 336));
    expect(later?.department_id).toBe(department);
    const events = await pool.query(
      "select 1 from outbox where tenant_id = $1 and event = 'roster.shift_scheduled'",
      [hospital.id],
    );
    expect(events.rowCount).toBe(4 + 3);
  });

  it('skips a person on approved leave, and refuses bad windows', async () => {
    await wipe();
    await ok(await shift(), 201);
    await pool.query(
      `insert into roster_leaves (tenant_id, user_id, starts_at, ends_at, status, decided_by, decided_at, created_by)
       values ($1, $2, $3, $4, 'approved', $5, now(), $2)`,
      [hospital.id, nurse.id, at(168), at(216), admin.id],
    );
    const result = await ok<CopyResult>(await copy());
    expect(result).toMatchObject({ copied: 0, skipped: [{ reason: 'on_leave' }] });
    expect(errorOf(await copy({ toStart: at(100) }))).toEqual([422, 'invalid_period']);
    expect(errorOf(await copy({ toStart: at(24) }))).toEqual([422, 'invalid_period']);
    expect(errorOf(await copy({ toStart: at(-168), weeks: 2 }))).toEqual([422, 'invalid_period']);
    await pool.query('delete from roster_leaves where tenant_id = $1', [hospital.id]);
  });

  it('is only for managers, only reads its own hospital, and repeats safely', async () => {
    await wipe();
    await ok(await shift(), 201);
    expect((await copy({}, { user: nurse })).statusCode).toBe(403);
    expect(await ok<CopyResult>(await copy({}, { tenant: clinic, user: clinicAdmin }))).toEqual({
      copied: 0,
      skipped: [],
    });
    expect(errorOf(await copy({}, { tenant: closed }))).toEqual([403, 'feature_disabled']);
    await ok(await copy({}, { key: 'copy-once-1' }));
    await ok(await copy({}, { key: 'copy-once-1' }));
    const { rows } = await pool.query('select 1 from roster_shifts where tenant_id = $1', [
      hospital.id,
    ]);
    expect(rows).toHaveLength(2);
  });
});

describe('swaps', () => {
  interface Swapped {
    created: Shift[];
  }
  const swap = (id: string, body: object, options: Options = {}) =>
    post(`/roster/shifts/${id}/swap`, body, options);

  it('hand a shift to someone else: the old one is cancelled, the new one points at it', async () => {
    await wipe();
    const made = await ok<Shift>(await shift({ departmentId: department }), 201);
    const done = await ok<Swapped>(await swap(made.id, { version: 1, userId: labTech.id }));
    expect(done.created).toHaveLength(1);
    expect(done.created[0]).toMatchObject({ userId: labTech.id, status: 'scheduled' });
    const { rows } = await pool.query<{ status: string; replaces_shift_id: string | null }>(
      'select status, replaces_shift_id from roster_shifts where tenant_id = $1 order by status',
      [hospital.id],
    );
    expect(rows.map((row) => row.status)).toEqual(['cancelled', 'scheduled']);
    expect(rows[1]?.replaces_shift_id).toBe(made.id);
    expect((await eventsOf(made.id)).map((event) => event.event)).toContain(
      'roster.shift_cancelled',
    );
    expect(errorOf(await swap(made.id, { version: 2, userId: nurse.id }))).toEqual([
      409,
      'invalid_transition',
    ]);
  });

  it('refuse a clash and leave everything as it was', async () => {
    await wipe();
    const mine = await ok<Shift>(await shift(), 201);
    await ok(await shift({ userId: labTech.id, startsAt: at(10), endsAt: at(14) }), 201);
    expect(errorOf(await swap(mine.id, { version: 1, userId: labTech.id }))).toEqual([
      409,
      'shift_overlap',
    ]);
    expect(errorOf(await swap(mine.id, { version: 1, userId: clinicAdmin.id }))).toEqual([
      422,
      'unknown_user',
    ]);
    expect(errorOf(await swap(mine.id, { version: 1, userId: nurse.id }))).toEqual([
      422,
      'invalid_swap',
    ]);
    expect(errorOf(await swap(mine.id, { version: 1 }))).toEqual([422, 'invalid_swap']);
    expect(errorOf(await swap(mine.id, { version: 9, userId: pharmacist.id }))).toEqual([
      409,
      'conflict',
    ]);
    const { rows } = await pool.query(
      "select 1 from roster_shifts where tenant_id = $1 and status = 'scheduled'",
      [hospital.id],
    );
    expect(rows).toHaveLength(2);
  });

  it('exchange two shifts, even ones that overlap in time', async () => {
    await wipe();
    const a = await ok<Shift>(await shift(), 201);
    const b = await ok<Shift>(
      await shift({ userId: labTech.id, startsAt: at(10), endsAt: at(18) }),
      201,
    );
    expect(errorOf(await swap(a.id, { version: 1, withShiftId: b.id }))).toEqual([
      422,
      'invalid_swap',
    ]);
    const done = await ok<Swapped>(
      await swap(a.id, { version: 1, withShiftId: b.id, withVersion: 1 }),
    );
    expect(done.created.map((one) => one.userId).sort()).toEqual([labTech.id, nurse.id].sort());
    expect(errorOf(await swap(a.id, { version: 2, withShiftId: a.id, withVersion: 1 }))).toEqual([
      409,
      'invalid_transition',
    ]);
  });

  it('are for managers, and one hospital cannot swap another’s shifts', async () => {
    await wipe();
    const made = await ok<Shift>(await shift(), 201);
    expect(
      (await swap(made.id, { version: 1, userId: labTech.id }, { user: nurse })).statusCode,
    ).toBe(403);
    expect(
      errorOf(
        await swap(
          made.id,
          { version: 1, userId: clinicAdmin.id },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'shift_not_found']);
  });
});

// --- leave -------------------------------------------------------------------------------------

interface Leave {
  id: string;
  userId: string;
  status: string;
  version: number;
  decidedByName?: string;
}
const leave = (more: object = {}, options: Options = {}) =>
  post('/roster/leaves', { startsAt: at(0), endsAt: at(48), ...more }, options);

describe('leave requests', () => {
  it('are asked by the person, decided by someone else, audited, with events', async () => {
    await wipe();
    const made = await ok<Leave>(await leave({}, { user: nurse }), 201);
    expect(made).toMatchObject({ userId: nurse.id, status: 'requested', version: 1 });
    expect(await audited('roster_leave', made.id)).toEqual(['create']);
    expect(
      errorOf(await post(`/roster/leaves/${made.id}/approve`, { version: 1 }, { user: nurse })),
    ).toEqual([403, 'permission_denied']);
    expect(errorOf(await post(`/roster/leaves/${made.id}/approve`, { version: 7 }))).toEqual([
      409,
      'conflict',
    ]);
    const approved = await ok<Leave>(
      await post(`/roster/leaves/${made.id}/approve`, { version: 1 }),
    );
    expect(approved).toMatchObject({ status: 'approved', decidedByName: 'Ops Admin', version: 2 });
    expect(errorOf(await post(`/roster/leaves/${made.id}/reject`, { version: 2 }))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect((await eventsOf(made.id)).map((event) => event.event)).toEqual([
      'roster.leave_requested',
      'roster.leave_approved',
    ]);
  });

  it('are never decided by the person who asked', async () => {
    await wipe();
    const made = await ok<Leave>(await leave(), 201);
    expect(errorOf(await post(`/roster/leaves/${made.id}/approve`, { version: 1 }))).toEqual([
      403,
      'own_request',
    ]);
    expect(errorOf(await post(`/roster/leaves/${made.id}/reject`, { version: 1 }))).toEqual([
      403,
      'own_request',
    ]);
  });

  it('refuse a bad period and an overlap with the same person’s leave', async () => {
    await wipe();
    expect(errorOf(await leave({ startsAt: at(5), endsAt: at(5) }, { user: nurse }))).toEqual([
      422,
      'invalid_period',
    ]);
    expect(errorOf(await leave({ endsAt: at(24 * 91) }, { user: nurse }))).toEqual([
      422,
      'invalid_period',
    ]);
    await ok<Leave>(await leave({}, { user: nurse }), 201);
    expect(errorOf(await leave({ startsAt: at(10), endsAt: at(60) }, { user: nurse }))).toEqual([
      409,
      'leave_overlap',
    ]);
    // Another person may take the same days; a rejected request frees them.
    await ok<Leave>(await leave({}, { user: labTech }), 201);
  });

  it('cannot be approved over a scheduled shift, and then block shifts', async () => {
    await wipe();
    const planned = await ok<Shift>(await shift(), 201);
    const made = await ok<Leave>(await leave({}, { user: nurse }), 201);
    expect(errorOf(await post(`/roster/leaves/${made.id}/approve`, { version: 1 }))).toEqual([
      409,
      'shifts_in_leave',
    ]);
    await ok<Shift>(await post(`/roster/shifts/${planned.id}/cancel`, { version: 1 }));
    await ok<Leave>(await post(`/roster/leaves/${made.id}/approve`, { version: 1 }));
    expect(errorOf(await shift())).toEqual([409, 'on_leave']);
    // A shift for someone else, or outside the leave, is fine.
    await ok<Shift>(await shift({ userId: labTech.id }), 201);
    await ok<Shift>(await shift({ startsAt: at(60), endsAt: at(68) }), 201);
    // Withdrawing the leave frees the days.
    await ok<Leave>(
      await post(`/roster/leaves/${made.id}/cancel`, { version: 2 }, { user: nurse }),
    );
    await ok<Shift>(await shift(), 201);
  });

  it('are withdrawn by their owner or a manager, not by someone else', async () => {
    await wipe();
    const made = await ok<Leave>(await leave({}, { user: nurse }), 201);
    expect(
      errorOf(await post(`/roster/leaves/${made.id}/cancel`, { version: 1 }, { user: labTech })),
    ).toEqual([403, 'permission_denied']);
    const withdrawn = await ok<Leave>(
      await post(`/roster/leaves/${made.id}/cancel`, { version: 1 }),
    );
    expect(withdrawn.status).toBe('cancelled');
    expect(
      errorOf(await post(`/roster/leaves/${made.id}/cancel`, { version: 2 }, { user: nurse })),
    ).toEqual([409, 'invalid_transition']);
    expect(errorOf(await post('/roster/leaves/not-an-id/cancel', { version: 1 }))).toEqual([
      404,
      'leave_not_found',
    ]);
  });

  it('are listed by window and status, for one hospital only, with the module on', async () => {
    await wipe();
    const mine = await ok<Leave>(await leave({}, { user: nurse }), 201);
    await ok<Leave>(await leave({ startsAt: at(100), endsAt: at(120) }, { user: labTech }), 201);
    await ok<Leave>(await post(`/roster/leaves/${mine.id}/reject`, { version: 1 }));
    const inWindow = await ok<Page<Leave>>(await get(`/roster/leaves?from=${at(0)}&to=${at(50)}`));
    expect(inWindow.items.map((one) => one.id)).toEqual([mine.id]);
    const rejected = await ok<Page<Leave>>(await get('/roster/leaves?status=rejected'));
    expect(rejected.items).toHaveLength(1);
    const paged = await ok<Page<Leave>>(await get('/roster/leaves?limit=1', { user: pharmacist }));
    expect(paged.nextCursor).not.toBeNull();
    expect(
      (await ok<Page<Leave>>(await get('/roster/leaves', { tenant: clinic, user: clinicAdmin })))
        .items,
    ).toEqual([]);
    expect(
      (
        await post(
          `/roster/leaves/${mine.id}/cancel`,
          { version: 2 },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
    expect(errorOf(await get('/roster/leaves', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

// --- blood bank --------------------------------------------------------------------------------

interface Unit {
  id: string;
  status: string;
  version: number;
  patientId?: string;
}
interface Detail {
  unit: Unit;
  history: { fromStatus?: string; toStatus: string; reason?: string }[];
}
let unitNo = 0;
const register = (more: object = {}, options: Options = {}) =>
  post(
    '/blood-units',
    {
      unitNumber: `BAG-${String(++unitNo).padStart(5, '0')}`,
      bloodGroup: 'O+',
      component: 'red_cells',
      volumeMl: 350,
      collectedAt: new Date(Date.now() - hour).toISOString(),
      expiresAt: new Date(Date.now() + 35 * 24 * hour).toISOString(),
      ...more,
    },
    { user: labTech, ...options },
  );
const move = (unit: Unit, to: string, more: object = {}, options: Options = {}) =>
  post(`/blood-units/${unit.id}/move`, { to, version: unit.version, ...more }, options);
/** Registers a unit and moves it as far as `to`, as the right people would. */
async function unitAt(to: 'collected' | 'testing' | 'available', more: object = {}) {
  let unit = await ok<Unit>(await register(more), 201);
  if (to === 'collected') return unit;
  unit = await ok<Unit>(await move(unit, 'testing', {}, { user: labTech }));
  if (to === 'testing') return unit;
  return ok<Unit>(await move(unit, 'available', {}, { user: labTech }));
}

describe('the blood bank', () => {
  it('registers a unit, once per number, with its first history entry and an event', async () => {
    await wipe();
    const unit = await ok<Unit>(await register({ unitNumber: 'DUP-1' }), 201);
    expect(unit.status).toBe('collected');
    expect(errorOf(await register({ unitNumber: 'DUP-1' }))).toEqual([409, 'duplicate_unit']);
    expect(errorOf(await register({ collectedAt: at(10), expiresAt: at(5) }))).toEqual([
      422,
      'invalid_period',
    ]);
    expect((await eventsOf(unit.id)).map((event) => event.event)).toEqual([
      'blood.unit_registered',
    ]);
    expect(await audited('blood_unit', unit.id)).toEqual(['create']);
    const detail = await ok<Detail>(await get(`/blood-units/${unit.id}`));
    expect(detail.history).toEqual([expect.objectContaining({ toStatus: 'collected' })]);
  });

  it('takes a unit from collection to transfusion, keeping every move', async () => {
    await wipe();
    const available = await unitAt('available');
    const reserved = await ok<Unit>(
      await move(available, 'reserved', { patientId }, { user: nurse }),
    );
    expect(reserved).toMatchObject({ status: 'reserved', patientId });
    const issued = await ok<Unit>(await move(reserved, 'issued', {}, { user: nurse }));
    expect(issued.patientId).toBe(patientId);
    const done = await ok<Unit>(await move(issued, 'transfused', {}, { user: nurse }));
    expect(done.status).toBe('transfused');
    const detail = await ok<Detail>(await get(`/blood-units/${done.id}`));
    expect(detail.history.map((entry) => entry.toStatus)).toEqual([
      'collected',
      'testing',
      'available',
      'reserved',
      'issued',
      'transfused',
    ]);
    const events = await eventsOf(done.id);
    expect(events.filter((event) => event.event === 'blood.unit_status_changed')).toHaveLength(5);
    expect(events.at(-1)?.payload).toMatchObject({ from: 'issued', to: 'transfused', patientId });
    expect(await audited('blood_unit', done.id)).toContain('read');
  });

  it('validates every transition: nothing skips, nothing leaves a final state', async () => {
    await wipe();
    const collected = await unitAt('collected');
    expect(errorOf(await move(collected, 'available', {}, { user: labTech }))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect(errorOf(await move(collected, 'issued', {}, { user: nurse }))).toEqual([
      409,
      'invalid_transition',
    ]);
    const testing = await unitAt('testing');
    expect(errorOf(await move(testing, 'reserved', { patientId }, { user: nurse }))).toEqual([
      409,
      'invalid_transition',
    ]);
    const available = await unitAt('available');
    expect(errorOf(await move(available, 'transfused', {}, { user: nurse }))).toEqual([
      409,
      'invalid_transition',
    ]);
    const discarded = await ok<Unit>(
      await move(available, 'discarded', { reason: 'Bag leaked' }, { user: labTech }),
    );
    for (const to of ['testing', 'available', 'reserved', 'discarded']) {
      expect(errorOf(await move(discarded, to, { patientId }, { user: labTech }))[1]).toBe(
        'invalid_transition',
      );
    }
    const detail = await ok<Detail>(await get(`/blood-units/${discarded.id}`));
    expect(detail.history.at(-1)).toMatchObject({ toStatus: 'discarded', reason: 'Bag leaked' });
  });

  it('needs a reason to discard, a patient to reserve, and a unit within its date', async () => {
    await wipe();
    const available = await unitAt('available');
    expect(errorOf(await move(available, 'discarded', {}, { user: labTech }))).toEqual([
      422,
      'reason_required',
    ]);
    expect(errorOf(await move(available, 'reserved', {}, { user: nurse }))).toEqual([
      422,
      'patient_required',
    ]);
    expect(
      errorOf(await move(available, 'reserved', { patientId: clinicPatientId }, { user: nurse })),
    ).toEqual([422, 'unknown_patient']);
    expect(errorOf(await move(available, 'expired', {}, { user: labTech }))).toEqual([
      409,
      'not_expired',
    ]);
    const old = await unitAt('available', {
      collectedAt: new Date(Date.now() - 3 * 24 * hour).toISOString(),
      expiresAt: new Date(Date.now() - 24 * hour).toISOString(),
    });
    expect(errorOf(await move(old, 'reserved', { patientId }, { user: nurse }))).toEqual([
      409,
      'unit_expired',
    ]);
    const expired = await ok<Unit>(await move(old, 'expired', {}, { user: labTech }));
    expect(expired.status).toBe('expired');
  });

  it('releases a reservation back to stock, and refuses a stale version', async () => {
    await wipe();
    const available = await unitAt('available');
    const reserved = await ok<Unit>(
      await move(available, 'reserved', { patientId }, { user: nurse }),
    );
    expect(errorOf(await move(available, 'discarded', { reason: 'x' }, { user: labTech }))).toEqual(
      [409, 'conflict'],
    );
    const back = await ok<Unit>(await move(reserved, 'available', {}, { user: nurse }));
    expect(back.status).toBe('available');
    expect(back.patientId).toBeUndefined();
  });

  it('splits the work: the bank tests and discards, the ward reserves and issues', async () => {
    await wipe();
    const collected = await unitAt('collected');
    expect(errorOf(await move(collected, 'testing', {}, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    const available = await unitAt('available');
    expect(errorOf(await move(available, 'discarded', { reason: 'x' }, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect((await register({}, { user: nurse })).statusCode).toBe(403);
    expect((await get('/blood-units', { user: pharmacist })).statusCode).toBe(403);
    expect(errorOf(await get('/blood-units', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('adds up what can be given now', async () => {
    await wipe();
    await unitAt('available');
    await unitAt('available');
    const held = await unitAt('available', { bloodGroup: 'A-', component: 'plasma' });
    await ok(await move(held, 'reserved', { patientId }, { user: nurse }));
    await unitAt('testing');
    const stock = await ok<{
      items: { bloodGroup: string; component: string; available: number; reserved: number }[];
    }>(await get('/blood-units/stock', { user: nurse }));
    expect(stock.items).toEqual([
      expect.objectContaining({ bloodGroup: 'A-', component: 'plasma', available: 0, reserved: 1 }),
      expect.objectContaining({
        bloodGroup: 'O+',
        component: 'red_cells',
        available: 2,
        reserved: 0,
      }),
    ]);
    const filtered = await ok<Page<Unit>>(
      await get('/blood-units?status=available&bloodGroup=O%2B'),
    );
    expect(filtered.items).toHaveLength(2);
  });

  it('expires units past their date by itself, once, for each hospital alone', async () => {
    await wipe();
    const past = {
      collectedAt: new Date(Date.now() - 3 * 24 * hour).toISOString(),
      expiresAt: new Date(Date.now() - hour).toISOString(),
    };
    const stale = await unitAt('available', past);
    const held = await unitAt('available', {
      collectedAt: past.collectedAt,
      expiresAt: new Date(Date.now() + 2000).toISOString(),
    });
    await ok<Unit>(await move(held, 'reserved', { patientId }, { user: nurse }));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const fresh = await unitAt('available');
    const testing = await unitAt('testing', past);
    const other = (
      await pool.query<{ id: string }>(
        `insert into blood_units (tenant_id, unit_number, blood_group, component, volume_ml, collected_at, expires_at, status, created_by)
         values ($1, 'CL-1', 'O+', 'red_cells', 350, now() - interval '3 days', now() - interval '1 hour', 'available', $2)
         returning id`,
        [clinic.id, clinicAdmin.id],
      )
    ).rows[0]!.id;
    expect(await expireBloodUnits(pool, hospital.id)).toBeGreaterThanOrEqual(2);
    const status = async (id: string) =>
      (await pool.query<{ status: string }>('select status from blood_units where id = $1', [id]))
        .rows[0]!.status;
    expect(await status(stale.id)).toBe('expired');
    expect(await status(held.id)).toBe('expired');
    expect(await status(fresh.id)).toBe('available');
    expect(await status(testing.id)).toBe('testing');
    expect(await status(other)).toBe('available');
    const history = await ok<{ history: { toStatus: string; actorId: string }[] }>(
      await get(`/blood-units/${stale.id}`),
    );
    expect(history.history.at(-1)).toMatchObject({ toStatus: 'expired' });
    const events = await eventsOf(stale.id);
    expect(events.filter((e) => e.payload.to === 'expired')).toHaveLength(1);
    expect(await expireBloodUnits(pool, hospital.id)).toBe(0);
    expect((await eventsOf(stale.id)).filter((e) => e.payload.to === 'expired')).toHaveLength(1);
    // the job covers every hospital with the blood bank on, and does not fail
    await expireBloodUnitsEverywhere(pool);
    expect(await status(fresh.id)).toBe('available');
  });

  it('is enforced by the database too, and by hospital', async () => {
    await wipe();
    const unit = await unitAt('collected');
    await expect(
      pool.query("update blood_units set status = 'available' where id = $1", [unit.id]),
    ).rejects.toThrow(/cannot go from collected to available/);
    await expect(
      pool.query('update blood_units set volume_ml = 500 where id = $1', [unit.id]),
    ).rejects.toThrow(/Only the status/);
    await expect(
      pool.query("update blood_units set status = 'testing', patient_id = $2 where id = $1", [
        unit.id,
        patientId,
      ]),
    ).rejects.toThrow();
    expect(
      (
        await post(
          `/blood-units/${unit.id}/move`,
          { to: 'testing', version: 1 },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await get(`/blood-units/${unit.id}`, { tenant: clinic, user: clinicAdmin })).statusCode,
    ).toBe(404);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('delete from blood_unit_events where tenant_id = app_tenant_id()'),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

// --- ambulances --------------------------------------------------------------------------------

interface Ambulance {
  id: string;
  status: string;
  version: number;
  registration: string;
}
interface Trip {
  id: string;
  status: string;
  version: number;
  ambulanceId?: string;
  ambulanceRegistration?: string;
  patientId?: string;
  crew: { userId: string; userName: string; duty: string }[];
}
let plate = 0;
const addAmbulance = (more: object = {}, options: Options = {}) =>
  post('/ambulances', { registration: `mh12-${++plate}`, kind: 'basic', ...more }, options);
const requestTrip = (more: object = {}, options: Options = { user: nurse }) =>
  post('/ambulance-trips', { pickup: 'Gate 4', destination: 'Ops Hospital', ...more }, options);
const moveTrip = (trip: Trip, to: string, more: object = {}, options: Options = { user: nurse }) =>
  post(`/ambulance-trips/${trip.id}/move`, { to, version: trip.version, ...more }, options);
const ambulanceNow = async (id: string) =>
  (await ok<Page<Ambulance>>(await get('/ambulances'))).items.find((item) => item.id === id);

describe('ambulances', () => {
  it('adds ambulances, once per registration, and takes one out of service', async () => {
    await wipe();
    const made = await ok<Ambulance>(await addAmbulance({ registration: 'mh12 ab 1234' }), 201);
    expect(made).toMatchObject({ registration: 'MH12 AB 1234', status: 'available' });
    expect(errorOf(await addAmbulance({ registration: 'MH12 AB 1234' }))).toEqual([
      409,
      'duplicate_registration',
    ]);
    const out = await ok<Ambulance>(
      await post(`/ambulances/${made.id}/service`, { status: 'out_of_service', version: 1 }),
    );
    expect(out.status).toBe('out_of_service');
    expect(
      errorOf(
        await post(`/ambulances/${made.id}/service`, { status: 'out_of_service', version: 2 }),
      ),
    ).toEqual([409, 'invalid_transition']);
    expect((await addAmbulance({}, { user: nurse })).statusCode).toBe(403);
  });

  it('runs a trip from request to completion, moving the ambulance with it', async () => {
    await wipe();
    const ambulance = await ok<Ambulance>(await addAmbulance(), 201);
    const trip = await ok<Trip>(await requestTrip({ patientId }), 201);
    expect(trip).toMatchObject({ status: 'requested', patientId });
    expect(errorOf(await moveTrip(trip, 'picked_up'))).toEqual([409, 'invalid_transition']);
    expect(errorOf(await moveTrip(trip, 'dispatched'))).toEqual([422, 'ambulance_required']);
    expect(errorOf(await moveTrip(trip, 'dispatched', { ambulanceId: clinicBedId }))).toEqual([
      422,
      'unknown_ambulance',
    ]);
    const sent = await ok<Trip>(await moveTrip(trip, 'dispatched', { ambulanceId: ambulance.id }));
    expect(sent).toMatchObject({ status: 'dispatched', ambulanceId: ambulance.id });
    expect((await ambulanceNow(ambulance.id))?.status).toBe('on_trip');
    const picked = await ok<Trip>(await moveTrip(sent, 'picked_up'));
    const done = await ok<Trip>(await moveTrip(picked, 'completed'));
    expect(done.status).toBe('completed');
    expect((await ambulanceNow(ambulance.id))?.status).toBe('available');
    expect(errorOf(await moveTrip(done, 'cancelled'))).toEqual([409, 'invalid_transition']);
    const events = (await eventsOf(trip.id)).map((event) => event.event);
    expect(events).toEqual([
      'ambulance.trip_requested',
      ...Array<string>(3).fill('ambulance.trip_status_changed'),
    ]);
    expect(await audited('ambulance_trip', trip.id)).toEqual([
      'create',
      'update',
      'update',
      'update',
    ]);
  });

  it('names the crew at dispatch, shows it on the trip and refuses what does not fit', async () => {
    await wipe();
    const [first, second, third] = [
      await ok<Ambulance>(await addAmbulance(), 201),
      await ok<Ambulance>(await addAmbulance(), 201),
      await ok<Ambulance>(await addAmbulance(), 201),
    ] as [Ambulance, Ambulance, Ambulance];
    const request = async () => ok<Trip>(await requestTrip(), 201);
    const trip = await request();
    expect(trip.crew).toEqual([]);
    const crew = [
      { userId: labTech.id, duty: 'paramedic' },
      { userId: pharmacist.id, duty: 'driver' },
    ];
    const bad = (body: object) => moveTrip(trip, 'dispatched', { ambulanceId: first.id, ...body });
    expect(errorOf(await bad({ crew: [{ userId: admin.id, duty: 'driver' }, ...crew] }))).toEqual([
      422,
      'invalid_crew',
    ]);
    expect(
      errorOf(await bad({ crew: [crew[0], { userId: labTech.id, duty: 'attendant' }] })),
    ).toEqual([422, 'invalid_crew']);
    expect(errorOf(await bad({ crew: [{ userId: clinicAdmin.id, duty: 'driver' }] }))).toEqual([
      422,
      'unknown_crew',
    ]);
    expect(errorOf(await bad({ crew: [{ userId: 'nope', duty: 'driver' }] }))).toEqual([
      422,
      'unknown_crew',
    ]);
    expect((await ambulanceNow(first.id))?.status).toBe('available');
    const sent = await ok<Trip>(await bad({ crew }));
    expect(sent.crew.map((member) => [member.userId, member.duty])).toEqual([
      [pharmacist.id, 'driver'],
      [labTech.id, 'paramedic'],
    ]);
    expect(sent.crew[0]?.userName).toBe('Ops Pharmacist');
    // Someone on a trip under way cannot go on another.
    const other = await request();
    expect(
      errorOf(
        await moveTrip(other, 'dispatched', {
          ambulanceId: second.id,
          crew: [{ userId: labTech.id, duty: 'driver' }],
        }),
      ),
    ).toEqual([409, 'crew_busy']);
    // The crew is not named at any other move.
    expect(errorOf(await moveTrip(sent, 'picked_up', { crew }))).toEqual([422, 'crew_at_dispatch']);
    const listed = (await ok<Page<Trip>>(await get('/ambulance-trips'))).items.find(
      (item) => item.id === trip.id,
    );
    expect(listed?.crew).toHaveLength(2);
    // Another hospital never sees it, and the crew is free once the trip ends.
    expect(
      (await ok<Page<Trip>>(await get('/ambulance-trips', { tenant: clinic, user: clinicAdmin })))
        .items,
    ).toEqual([]);
    const done = await ok<Trip>(
      await moveTrip(await ok<Trip>(await moveTrip(sent, 'picked_up')), 'completed'),
    );
    expect(done.crew).toHaveLength(2);
    const again = await ok<Trip>(
      await moveTrip(other, 'dispatched', {
        ambulanceId: third.id,
        crew: [{ userId: labTech.id, duty: 'driver' }],
      }),
    );
    expect(again.crew).toHaveLength(1);
  });

  it('keeps the visit and service of a billable trip, and refuses ones that do not fit', async () => {
    await wipe();
    const encounter = await pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'er', $3) returning id`,
      [hospital.id, patientId, admin.id],
    );
    const encounterId = encounter.rows[0]?.id ?? '';
    const service = async (tenant: TestTenant, code: string, archived = false) =>
      (
        await pool.query<{ id: string }>(
          `insert into services (tenant_id, code, name, category, tax_class, archived)
           values ($1, $2, 'Ambulance transfer', 'procedure', 'exempt', $3) returning id`,
          [tenant.id, code, archived],
        )
      ).rows[0]?.id ?? '';
    const serviceId = await service(hospital, 'AMB-1');
    const trip = await ok<Trip & { encounterId?: string; serviceName?: string }>(
      await requestTrip({ patientId, encounterId, serviceId }),
      201,
    );
    expect(trip).toMatchObject({ encounterId, serviceId, serviceName: 'Ambulance transfer' });
    const ambulance = await ok<Ambulance>(await addAmbulance(), 201);
    const sent = await ok<Trip>(await moveTrip(trip, 'dispatched', { ambulanceId: ambulance.id }));
    const done = await ok<Trip>(
      await moveTrip(await ok<Trip>(await moveTrip(sent, 'picked_up')), 'completed'),
    );
    expect(done.status).toBe('completed');
    const completed = (await eventsOf(trip.id)).at(-1);
    expect(completed?.payload).toMatchObject({ to: 'completed', encounterId, serviceId });
    expect(errorOf(await requestTrip({ encounterId }))).toEqual([422, 'unknown_encounter']);
    expect(errorOf(await requestTrip({ patientId, serviceId }))).toEqual([
      422,
      'encounter_required',
    ]);
    expect(errorOf(await requestTrip({ patientId, encounterId, serviceId: randomUUID() }))).toEqual(
      [422, 'unknown_service'],
    );
    const old = await service(hospital, 'AMB-OLD', true);
    expect(errorOf(await requestTrip({ patientId, encounterId, serviceId: old }))).toEqual([
      422,
      'unknown_service',
    ]);
    // Another hospital's service is not found, nor its visit.
    const foreign = await service(clinic, 'AMB-2');
    expect(errorOf(await requestTrip({ patientId, encounterId, serviceId: foreign }))).toEqual([
      422,
      'unknown_service',
    ]);
    await pool.query(
      "update encounters set status = 'cancelled', cancel_reason = 'x', ended_at = now(), ended_by = $2 where id = $1",
      [encounterId, admin.id],
    );
    expect(errorOf(await requestTrip({ patientId, encounterId }))).toEqual([
      422,
      'unknown_encounter',
    ]);
  });

  it('sends one ambulance on one trip, and not one that is out of service', async () => {
    await wipe();
    const first = await ok<Ambulance>(await addAmbulance(), 201);
    const spare = await ok<Ambulance>(await addAmbulance(), 201);
    const tripA = await ok<Trip>(await requestTrip(), 201);
    const tripB = await ok<Trip>(await requestTrip(), 201);
    await ok(await moveTrip(tripA, 'dispatched', { ambulanceId: first.id }));
    expect(errorOf(await moveTrip(tripB, 'dispatched', { ambulanceId: first.id }))).toEqual([
      409,
      'ambulance_unavailable',
    ]);
    await ok(
      await post(`/ambulances/${spare.id}/service`, { status: 'out_of_service', version: 1 }),
    );
    expect(errorOf(await moveTrip(tripB, 'dispatched', { ambulanceId: spare.id }))).toEqual([
      409,
      'ambulance_unavailable',
    ]);
    // The database holds the same line.
    await expect(
      pool.query("update ambulances set status = 'available' where id = $1", [first.id]).then(() =>
        pool.query(
          `insert into ambulance_trips (tenant_id, ambulance_id, pickup, destination, status, requested_by, dispatched_at)
           values ($1, $2, 'a', 'b', 'dispatched', $3, now())`,
          [hospital.id, first.id, admin.id],
        ),
      ),
    ).rejects.toThrow(/ambulance_trips_one_live/);
  });

  it('frees the ambulance when a dispatched trip is cancelled', async () => {
    await wipe();
    const ambulance = await ok<Ambulance>(await addAmbulance(), 201);
    const trip = await ok<Trip>(await requestTrip(), 201);
    const sent = await ok<Trip>(await moveTrip(trip, 'dispatched', { ambulanceId: ambulance.id }));
    const cancelled = await ok<Trip>(await moveTrip(sent, 'cancelled'));
    expect(cancelled.status).toBe('cancelled');
    expect((await ambulanceNow(ambulance.id))?.status).toBe('available');
    expect(errorOf(await moveTrip(sent, 'picked_up'))).toEqual([409, 'conflict']);
  });

  it('lists trips by status, hides other hospitals, and refuses what it must', async () => {
    await wipe();
    await ok(await requestTrip(), 201);
    const trip = await ok<Trip>(await requestTrip({ patientId }), 201);
    await ok(await moveTrip(trip, 'cancelled'));
    const requested = await ok<Page<Trip>>(await get('/ambulance-trips?status=requested'));
    expect(requested.items).toHaveLength(1);
    expect(
      (await ok<Page<Trip>>(await get('/ambulance-trips', { tenant: clinic, user: clinicAdmin })))
        .items,
    ).toEqual([]);
    expect(errorOf(await requestTrip({ patientId: clinicPatientId }))).toEqual([
      422,
      'unknown_patient',
    ]);
    expect((await requestTrip({}, { user: pharmacist })).statusCode).toBe(403);
    expect(errorOf(await get('/ambulance-trips', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(
      (
        await post(
          `/ambulance-trips/${trip.id}/move`,
          { to: 'cancelled', version: 1 },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
  });
});

// --- cleaning tasks ----------------------------------------------------------------------------

interface Task {
  id: string;
  status: string;
  version: number;
  kind: string;
  bedNumber: string;
  assignedTo?: string;
}
const bedStatus = async (bedId: string) =>
  (await pool.query<{ status: string }>('select status from beds where id = $1', [bedId])).rows[0]
    ?.status;
const makeTask = (bedId: string, more: object = {}, options: Options = {}) =>
  post('/cleaning-tasks', { bedId, ...more }, options);
const moveTask = (task: Task, to: string, options: Options = { user: nurse }) =>
  post(`/cleaning-tasks/${task.id}/move`, { to, version: task.version }, options);

describe('cleaning tasks', () => {
  it('asks for a bed to be cleaned: the bed goes to cleaning, then ready when done', async () => {
    await wipe();
    const task = await ok<Task>(await makeTask(beds[0] as string), 201);
    expect(task).toMatchObject({ status: 'open', kind: 'routine', bedNumber: 'B1' });
    expect(await bedStatus(beds[0] as string)).toBe('cleaning');
    expect(errorOf(await makeTask(beds[0] as string))).toEqual([409, 'task_exists']);
    expect(errorOf(await moveTask(task, 'done'))).toEqual([409, 'invalid_transition']);
    const started = await ok<Task>(await moveTask(task, 'in_progress'));
    expect(started).toMatchObject({ status: 'in_progress', assignedTo: nurse.id });
    const done = await ok<Task>(await moveTask(started, 'done'));
    expect(done.status).toBe('done');
    expect(await bedStatus(beds[0] as string)).toBe('available');
    expect((await eventsOf(task.id)).map((event) => event.event)).toEqual([
      'cleaning.task_created',
      'cleaning.task_completed',
    ]);
    expect(await audited('cleaning_task', task.id)).toEqual(['create', 'update', 'update']);
    // The bed is free of a live task, so a new one can be made.
    await ok(await makeTask(beds[0] as string), 201);
  });

  it('refuses an occupied or blocked bed, an unknown one and another hospital’s', async () => {
    await wipe();
    await pool.query("update beds set status = 'occupied' where id = $1", [beds[1]]);
    await pool.query(
      "update beds set status = 'blocked', blocked_reason = 'repair' where id = $1",
      [beds[2]],
    );
    expect(errorOf(await makeTask(beds[1] as string))).toEqual([409, 'bed_not_available']);
    expect(errorOf(await makeTask(beds[2] as string))).toEqual([409, 'bed_not_available']);
    expect(errorOf(await makeTask(clinicBedId))).toEqual([422, 'unknown_bed']);
    expect(errorOf(await makeTask(beds[0] as string, { assignedTo: clinicAdmin.id }))).toEqual([
      422,
      'unknown_user',
    ]);
  });

  it('cancels only for those who manage the work, and leaves the bed as it is', async () => {
    await wipe();
    const task = await ok<Task>(await makeTask(beds[0] as string, { assignedTo: nurse.id }), 201);
    expect(task.assignedTo).toBe(nurse.id);
    expect(errorOf(await moveTask(task, 'cancelled', { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await moveTask(task, 'in_progress', { user: pharmacist }))[0]).toBe(403);
    const cancelled = await ok<Task>(await moveTask(task, 'cancelled', { user: admin }));
    expect(cancelled.status).toBe('cancelled');
    expect(await bedStatus(beds[0] as string)).toBe('cleaning');
    expect(errorOf(await makeTask(beds[0] as string, {}, { user: nurse }))[0]).toBe(403);
    expect(errorOf(await get('/cleaning-tasks', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('lists tasks by status and ward, for the hospital alone', async () => {
    await wipe();
    await ok(await makeTask(beds[0] as string), 201);
    const other = await ok<Task>(await makeTask(beds[1] as string), 201);
    await ok(await moveTask(other, 'in_progress'));
    expect(
      (await ok<Page<Task>>(await get(`/cleaning-tasks?status=in_progress&wardId=${ward}`))).items,
    ).toHaveLength(1);
    expect((await ok<Page<Task>>(await get('/cleaning-tasks'))).items).toHaveLength(2);
    expect(
      (await ok<Page<Task>>(await get('/cleaning-tasks', { tenant: clinic, user: clinicAdmin })))
        .items,
    ).toEqual([]);
    expect((await moveTask(other, 'done', { tenant: clinic, user: clinicAdmin })).statusCode).toBe(
      404,
    );
  });

  it('makes a task when a patient leaves a bed, once, and only with housekeeping on', async () => {
    await wipe();
    await pool.query("update beds set status = 'cleaning' where id = $1", [beds[3]]);
    const release = async (
      tenant: TestTenant,
      bedId: string,
      wardId: string,
      reason = 'discharge',
    ) => {
      await pool.query(
        `insert into outbox (tenant_id, event, entity_id, actor_id, payload)
         values ($1, 'bed.released', $2, null, $3)`,
        [tenant.id, bedId, JSON.stringify({ wardId, reason })],
      );
      await app.events.dispatch();
      await jobs.drain();
    };
    // An admission cancelled by mistake makes no task: its bed is ready at once.
    await release(hospital, beds[3] as string, ward, 'cancelled');
    expect((await ok<Page<Task>>(await get('/cleaning-tasks'))).items).toEqual([]);
    await release(hospital, beds[3] as string, ward);
    await release(hospital, beds[3] as string, ward);
    const tasks = await ok<Page<Task>>(await get('/cleaning-tasks'));
    expect(tasks.items).toEqual([
      expect.objectContaining({ kind: 'discharge', status: 'open', bedNumber: 'B4' }),
    ]);
    // The task finishes the way the others do.
    await ok(await moveTask(tasks.items[0] as Task, 'in_progress'));
    const started = (await ok<Page<Task>>(await get('/cleaning-tasks'))).items[0] as Task;
    await ok(await moveTask(started, 'done'));
    expect(await bedStatus(beds[3] as string)).toBe('available');
    // A hospital that has housekeeping off gets none.
    await pool.query(
      "update tenant_features set enabled = false where tenant_id = $1 and feature = 'housekeeping'",
      [clinic.id],
    );
    await release(clinic, clinicBedId, ward);
    const { rows } = await pool.query('select 1 from cleaning_tasks where tenant_id = $1', [
      clinic.id,
    ]);
    expect(rows).toHaveLength(0);
    await pool.query(
      "update tenant_features set enabled = true where tenant_id = $1 and feature = 'housekeeping'",
      [clinic.id],
    );
  });
});

describe('row-level security', () => {
  it('shows a hospital none of another’s operations rows', async () => {
    await wipe();
    await ok(await shift(), 201);
    await ok(await leave({ startsAt: at(200), endsAt: at(220) }), 201);
    await ok(await register(), 201);
    await ok(await template({ name: 'RLS template' }), 201);
    const rls = await ok<Ambulance>(await addAmbulance(), 201);
    const rlsTrip = await ok<Trip>(await requestTrip(), 201);
    await ok(
      await moveTrip(rlsTrip, 'dispatched', {
        ambulanceId: rls.id,
        crew: [{ userId: nurse.id, duty: 'driver' }],
      }),
    );
    await ok(await makeTask(beds[0] as string), 201);
    for (const table of TABLES) {
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
          'insert into ambulances (tenant_id, registration, kind, created_by) values ($1, $2, $3, $4)',
          [hospital.id, 'X1', 'basic', admin.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
