import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
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
 * Packages (#117): what a package includes and excludes, applying one to a visit as a single
 * charge that replaces the charges for what it includes, now and later, and the hospital boundary.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let desk: TestUser;
let clinicAdmin: TestUser;
let encounter = '';
let clinicEncounter = '';
let counter = 0;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Charge {
  id: string;
  source: string;
  description: string;
  unitPriceMinor: number;
  status: string;
  flag?: string;
}
interface Contents {
  items: { serviceId: string; code: string; name: string; kind: string }[];
}
type Reply = { statusCode: number; body: string; json: <T = { error: { code: string } }>() => T };

const get = (url: string, { tenant = hospital, user = admin }: Options = {}) =>
  app.inject({ url, headers: as(tenant.id, user.id) });
const send = (
  method: 'POST' | 'PUT',
  url: string,
  body: object,
  { tenant = hospital, user = admin, key = randomUUID() }: Options = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': key },
    payload: body,
  });
const errorOf = (reply: Reply) => [reply.statusCode, reply.json().error.code];

async function ok<T>(reply: Promise<Reply> | Reply, status = 200): Promise<T> {
  const answer = await reply;
  if (answer.statusCode !== status) {
    throw new Error(`expected ${status}, got ${answer.statusCode} ${answer.body}`);
  }
  return answer.json<T>();
}

async function addService(
  tenant: TestTenant,
  category: string,
  price: number | null,
  archived = false,
) {
  counter += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into services (tenant_id, code, name, category, tax_class, archived)
     values ($1, $2, $3, $4, 'exempt', $5) returning id`,
    [tenant.id, `PK${counter}`, `Service ${counter}`, category, archived],
  );
  const id = rows[0]?.id ?? '';
  if (price !== null) {
    await pool.query(
      `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
       select $1, $2, id, $3, current_date - 10 from price_lists where tenant_id = $1 and standard`,
      [tenant.id, id, price],
    );
  }
  return id;
}

async function addCharge(encounterId: string, serviceId: string, price: number) {
  counter += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
       description, quantity, unit_price_minor)
     select e.tenant_id, e.id, e.patient_id, $2, 'service', $3, 'Test', 1, $4
       from encounters e where e.id = $1 returning id`,
    [encounterId, serviceId, `test:pk:${counter}`, price],
  );
  return rows[0]?.id ?? '';
}

const statusOf = async (id: string) =>
  (
    await pool.query<{ status: string; flag: string | null; by: string | null }>(
      'select status, flag, package_charge_id as by from charges where id = $1',
      [id],
    )
  ).rows[0];

const contents = (packageId: string, items: object[], options: Options = {}) =>
  send('PUT', `/services/${packageId}/package`, { items }, options);
const apply = (encounterId: string, serviceId: string, options: Options = {}) =>
  send('POST', `/encounters/${encounterId}/packages`, { serviceId }, options);

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { patients: true, clinical: true, services: true, billing: true };
  hospital = await createTenant(pool, 'Package Hospital', { features });
  clinic = await createTenant(pool, 'Package Clinic', { features });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Package Admin');
  desk = await user('Package Desk');
  clinicAdmin = await user('Package Clinic Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  for (const tenant of [hospital, clinic]) {
    const patient = await pool.query<{ id: string }>(
      `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
       values ($1, 'PK-0000001', 'Asha', 'Test', '1980-05-01', 'female', '+91 9800000000', 'test')
       returning id`,
      [tenant.id],
    );
    const visit = await pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by)
       values ($1, $2, 'opd', $3) returning id`,
      [tenant.id, patient.rows[0]?.id, tenant === hospital ? admin.id : clinicAdmin.id],
    );
    if (tenant === hospital) encounter = visit.rows[0]?.id ?? '';
    else clinicEncounter = visit.rows[0]?.id ?? '';
  }
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'package_items',
      'invoice_lines',
      'invoices',
      'charges',
      'service_prices',
      'services',
      'encounters',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital, clinic]);
  await deleteUsers(pool, [admin, desk, clinicAdmin]);
  await app.close();
});

describe('package contents', () => {
  it('replaces the contents as a whole and lists them', async () => {
    const pkg = await addService(hospital, 'package', 100_000);
    const a = await addService(hospital, 'lab', 5_000);
    const b = await addService(hospital, 'imaging', 9_000);
    const c = await addService(hospital, 'procedure', 20_000);
    const set = await ok<Contents>(
      contents(pkg, [
        { serviceId: a, kind: 'included' },
        { serviceId: b, kind: 'included' },
        { serviceId: c, kind: 'excluded' },
      ]),
    );
    expect(set.items.map((item) => item.kind).sort()).toEqual(['excluded', 'included', 'included']);
    await ok(contents(pkg, [{ serviceId: a, kind: 'included' }]));
    const read = await ok<Contents>(get(`/services/${pkg}/package`));
    expect(read.items).toHaveLength(1);
    expect(read.items[0]).toMatchObject({ serviceId: a, kind: 'included' });
  });

  it('refuses what cannot be in a package', async () => {
    const pkg = await addService(hospital, 'package', 100_000);
    const other = await addService(hospital, 'package', 1);
    const plain = await addService(hospital, 'lab', 5_000);
    const archived = await addService(hospital, 'lab', 5_000, true);
    const foreign = await addService(clinic, 'lab', 5_000);
    for (const bad of [pkg, other, archived, foreign, randomUUID()]) {
      expect(errorOf(await contents(pkg, [{ serviceId: bad, kind: 'included' }]))).toEqual([
        422,
        'invalid_package_item',
      ]);
    }
    expect(
      errorOf(
        await contents(pkg, [
          { serviceId: plain, kind: 'included' },
          { serviceId: plain, kind: 'excluded' },
        ]),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(errorOf(await contents(plain, []))).toEqual([409, 'not_a_package']);
    expect(errorOf(await get(`/services/${plain}/package`))).toEqual([409, 'not_a_package']);
  });

  it('needs the permission, and never crosses hospitals', async () => {
    const pkg = await addService(hospital, 'package', 100_000);
    expect(errorOf(await contents(pkg, [], { user: desk }))).toEqual([403, 'permission_denied']);
    expect(
      errorOf(await get(`/services/${pkg}/package`, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'service_not_found']);
    expect(errorOf(await contents(pkg, [], { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'service_not_found',
    ]);
  });

  it('is a repeat of one key answered once', async () => {
    const pkg = await addService(hospital, 'package', 100_000);
    const a = await addService(hospital, 'lab', 5_000);
    const key = randomUUID();
    const body = [{ serviceId: a, kind: 'included' }];
    expect((await contents(pkg, body, { key })).statusCode).toBe(200);
    const again = await contents(pkg, body, { key });
    expect(again.statusCode).toBe(200);
    expect(again.json<Contents>().items).toHaveLength(1);
  });
});

describe('applying a package', () => {
  async function setup(price: number | null = 100_000) {
    const pkg = await addService(hospital, 'package', price);
    const inside = await addService(hospital, 'lab', 5_000);
    const outside = await addService(hospital, 'procedure', 20_000);
    await ok(
      contents(pkg, [
        { serviceId: inside, kind: 'included' },
        { serviceId: outside, kind: 'excluded' },
      ]),
    );
    return { pkg, inside, outside };
  }

  async function freshVisit() {
    const { rows } = await pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by)
       select tenant_id, patient_id, 'opd', opened_by from encounters where id = $1 returning id`,
      [encounter],
    );
    return rows[0]?.id ?? '';
  }

  it('posts one charge at the package price and replaces the included charges', async () => {
    const { pkg, inside, outside } = await setup();
    const visit = await freshVisit();
    const covered = await addCharge(visit, inside, 5_000);
    const separate = await addCharge(visit, outside, 20_000);
    const charge = await ok<Charge>(apply(visit, pkg), 201);
    expect(charge).toMatchObject({ source: 'package', unitPriceMinor: 100_000, status: 'pending' });
    expect(await statusOf(covered)).toMatchObject({
      status: 'void',
      flag: 'package_covered',
      by: charge.id,
    });
    expect(await statusOf(separate)).toMatchObject({ status: 'pending', flag: null });
  });

  it('covers an included charge posted afterwards and still bills an excluded one', async () => {
    const { pkg, inside, outside } = await setup();
    const visit = await freshVisit();
    const charge = await ok<Charge>(apply(visit, pkg), 201);
    const later = await ok<Charge>(
      send('POST', `/encounters/${visit}/charges`, { serviceId: inside, quantity: 1 }),
      201,
    );
    expect(later).toMatchObject({ status: 'void', flag: 'package_covered' });
    expect((await statusOf(later.id))?.by).toBe(charge.id);
    const billed = await ok<Charge>(
      send('POST', `/encounters/${visit}/charges`, { serviceId: outside, quantity: 1 }),
      201,
    );
    expect(billed).toMatchObject({ status: 'pending' });
    expect(billed.flag).toBeUndefined();
  });

  it('leaves another visit alone', async () => {
    const { pkg, inside } = await setup();
    const visit = await freshVisit();
    const elsewhere = await freshVisit();
    const mine = await addCharge(elsewhere, inside, 5_000);
    await ok(apply(visit, pkg), 201);
    expect((await statusOf(mine))?.status).toBe('pending');
  });

  it('is refused for a package that cannot be applied', async () => {
    const visit = await freshVisit();
    const { pkg } = await setup();
    const empty = await addService(hospital, 'package', 100);
    const unpriced = (await setup(null)).pkg;
    const archived = await addService(hospital, 'package', 100, true);
    const plain = await addService(hospital, 'lab', 100);
    expect(errorOf(await apply(visit, empty))).toEqual([409, 'package_empty']);
    expect(errorOf(await apply(visit, unpriced))).toEqual([409, 'no_price']);
    expect(errorOf(await apply(visit, archived))).toEqual([409, 'service_archived']);
    expect(errorOf(await apply(visit, plain))).toEqual([409, 'not_a_package']);
    expect(errorOf(await apply(visit, randomUUID()))).toEqual([404, 'service_not_found']);
    expect(errorOf(await apply(randomUUID(), pkg))).toEqual([404, 'encounter_not_found']);
    await ok(apply(visit, pkg), 201);
    expect(errorOf(await apply(visit, pkg))).toEqual([409, 'package_applied']);
  });

  it('is refused on a cancelled visit', async () => {
    const { pkg } = await setup();
    const visit = await freshVisit();
    await pool.query(
      "update encounters set status = 'cancelled', cancel_reason = 'test', ended_at = now(), ended_by = opened_by where id = $1",
      [visit],
    );
    expect(errorOf(await apply(visit, pkg))).toEqual([409, 'encounter_cancelled']);
  });

  it('applies once for a repeated key and needs the permission', async () => {
    const { pkg } = await setup();
    const visit = await freshVisit();
    const key = randomUUID();
    const first = await ok<Charge>(apply(visit, pkg, { key }), 201);
    const again = await ok<Charge>(apply(visit, pkg, { key }), 201);
    expect(again.id).toBe(first.id);
    const { rows } = await pool.query(
      "select 1 from charges where encounter_id = $1 and source = 'package'",
      [visit],
    );
    expect(rows).toHaveLength(1);
    const other = await freshVisit();
    expect((await apply(other, pkg, { user: desk })).statusCode).toBe(201);
  });

  it('does not reach a visit of another hospital', async () => {
    const { pkg } = await setup();
    expect(errorOf(await apply(clinicEncounter, pkg))).toEqual([404, 'encounter_not_found']);
    expect(errorOf(await apply(encounter, pkg, { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'encounter_not_found',
    ]);
  });
});

describe('applying a package, the edges', () => {
  async function build() {
    const pkg = await addService(hospital, 'package', 100_000);
    const inside = await addService(hospital, 'lab', 5_000);
    await ok(contents(pkg, [{ serviceId: inside, kind: 'included' }]));
    const { rows } = await pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by)
       select tenant_id, patient_id, 'opd', opened_by from encounters where id = $1 returning id`,
      [encounter],
    );
    return { pkg, inside, visit: rows[0]?.id ?? '' };
  }

  it('never bills an included service on top of the package, whichever lands first', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { pkg, inside, visit } = await build();
      const [applied, posted] = await Promise.all([
        apply(visit, pkg),
        send('POST', `/encounters/${visit}/charges`, { serviceId: inside, quantity: 1 }),
      ]);
      expect(applied.statusCode).toBe(201);
      expect(posted.statusCode).toBe(201);
      const { rows } = await pool.query(
        `select 1 from charges
          where encounter_id = $1 and service_id = $2 and status = 'pending'`,
        [visit, inside],
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('leaves a charge already on a draft for the desk', async () => {
    const { pkg, inside, visit } = await build();
    const held = await addCharge(visit, inside, 5_000);
    await ok(
      send('POST', `/encounters/${visit}/invoices`, { chargeIds: [held], manualLines: [] }),
      201,
    );
    await ok(apply(visit, pkg), 201);
    expect(await statusOf(held)).toMatchObject({ status: 'pending', flag: null, by: null });
  });

  it('keeps a covered charge void, and a void package covers nothing more', async () => {
    const { pkg, inside, visit } = await build();
    const covered = await addCharge(visit, inside, 5_000);
    const charge = await ok<Charge>(apply(visit, pkg), 201);
    await expect(
      pool.query("update charges set status = 'pending' where id = $1", [covered]),
    ).rejects.toThrow();
    await expect(
      pool.query('update charges set package_charge_id = null where id = $1', [covered]),
    ).rejects.toThrow();
    await pool.query("update charges set status = 'void' where id = $1", [charge.id]);
    const later = await ok<Charge>(
      send('POST', `/encounters/${visit}/charges`, { serviceId: inside, quantity: 1 }),
      201,
    );
    expect(later).toMatchObject({ status: 'pending' });
  });

  it('is behind the billing module flag', async () => {
    const closed = await createTenant(pool, 'Package Closed', {
      features: { patients: true, clinical: true, services: true, billing: false },
    });
    await grantRoleDefaults(app, closed);
    await addMembership(pool, admin, closed, 'admin');
    try {
      const id = randomUUID();
      for (const reply of [
        await get(`/services/${id}/package`, { tenant: closed }),
        await contents(id, [], { tenant: closed }),
        await apply(id, id, { tenant: closed }),
      ]) {
        expect(errorOf(reply)).toEqual([403, 'feature_disabled']);
      }
    } finally {
      await deleteTenants(pool, [closed]);
    }
  });
});
