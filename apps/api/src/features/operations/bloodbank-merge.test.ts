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
 * Blood groups and cross-matches follow a patient merge (#936): the append-only rows stay where
 * they were written and are read through the surviving patient, and an unmerge gives them back.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let clinicAdmin: TestUser;
let seq = 0;
let unitNo = 0;

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Unit {
  id: string;
  version: number;
  status: string;
}
interface Group {
  patientId: string;
  bloodGroup?: string;
  history: { bloodGroup: string; reason?: string; fromPatientId?: string }[];
}
interface Listed {
  items: { unit: { id: string }; crossmatchValid: boolean }[];
}
const day = 24 * 3_600_000;
const headers = (tenant = hospital, user = admin, key?: string) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
const fresh = () => `bm-key-${String(++seq).padStart(6, '0')}`;
const get = (url: string, tenant = hospital, user = admin) =>
  app.inject({ url, headers: headers(tenant, user) });
const post = (url: string, body: object, tenant = hospital, user = admin) =>
  app.inject({ method: 'POST', url, headers: headers(tenant, user, fresh()), payload: body });
async function ok<Body>(response: Response, status = 200): Promise<Body> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return response.json<Body>();
}
const errorOf = (r: Response) => [r.statusCode, r.json<{ error: { code: string } }>().error.code];

async function patient(tenant: TestTenant) {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Blood', 'Merge', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `BM-${tenant.id.slice(0, 4)}-${seq}`],
  );
  return rows[0]!.id;
}
const version = async (id: string) =>
  (await pool.query<{ version: number }>('select version from patients where id = $1', [id]))
    .rows[0]!.version;
const merge = async (target: string, source: string) =>
  ok<{ id: string }>(
    await post(`/patients/${target}/merge`, {
      sourcePatientId: source,
      reason: 'Duplicate registration',
      expectedVersion: await version(target),
      expectedSourceVersion: await version(source),
    }),
    201,
  );
const unmerge = async (source: string) =>
  ok(await post(`/patients/${source}/unmerge`, { reason: 'Merged by mistake' }));
const groupOf = async (id: string) => ok<Group>(await get(`/patients/${id}/blood-group`));
const setGroup = (id: string, bloodGroup: string, reason?: string) =>
  post(`/patients/${id}/blood-group`, { bloodGroup, ...(reason ? { reason } : {}) });

const negative = {
  hiv: 'negative',
  hbv: 'negative',
  hcv: 'negative',
  syphilis: 'negative',
  malaria: 'negative',
};
const unitOf = async (id: string) =>
  (await ok<{ unit: Unit }>(await get(`/blood-units/${id}`))).unit;
/** An available O+ red cell unit. */
async function availableUnit(): Promise<Unit> {
  const donor = await ok<{ id: string }>(
    await post('/blood/donors', {
      fullName: 'Ravi Kumar',
      dateOfBirth: new Date(Date.now() - 30 * 365.25 * day).toISOString().slice(0, 10),
      sex: 'male',
      bloodGroup: 'O+',
    }),
    201,
  );
  const collection = await ok<{ unitIds: string[] }>(
    await post('/blood/collections', {
      donorId: donor.id,
      volumeMl: 450,
      units: [
        {
          unitNumber: `BMU-${String(++unitNo).padStart(5, '0')}`,
          component: 'red_cells',
          volumeMl: 350,
          expiresAt: new Date(Date.now() + 30 * day).toISOString(),
        },
      ],
    }),
    201,
  );
  let unit = await unitOf(collection.unitIds[0]!);
  unit = await ok<Unit>(
    await post(`/blood-units/${unit.id}/move`, { to: 'testing', version: unit.version }),
  );
  await ok(await post(`/blood-units/${unit.id}/screening`, negative), 201);
  unit = await unitOf(unit.id);
  return ok<Unit>(
    await post(`/blood-units/${unit.id}/move`, { to: 'available', version: unit.version }),
  );
}
const reserve = (unit: Unit, patientId: string) =>
  post(`/blood-units/${unit.id}/move`, { to: 'reserved', patientId, version: unit.version });
const crossmatch = (unit: Unit, patientId: string) =>
  post(`/blood-units/${unit.id}/crossmatch`, { patientId, result: 'compatible' });

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = { bloodbank: true, patients: true };
  hospital = await createTenant(pool, 'Blood Merge Hospital', { features: on });
  clinic = await createTenant(pool, 'Blood Merge Clinic', { features: on });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Blood Merge Admin', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Blood Merge Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
}, 60_000);

afterAll(async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      const tenants = [hospital.id, clinic.id];
      for (const table of [
        'blood_crossmatches',
        'blood_screenings',
        'patient_blood_groups',
        'blood_unit_events',
        'blood_units',
        'blood_collections',
        'blood_donors',
        'patient_merges',
        'outbox',
        'patients',
      ]) {
        await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants]);
      }
      await client.query('commit');
    } finally {
      client.release();
    }
    await deleteUsers(pool, [admin, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('blood group and a patient merge', () => {
  it('reads the merged-away entries through the survivor, then gives them back on unmerge', async () => {
    const target = await patient(hospital);
    const source = await patient(hospital);
    await ok(await setGroup(source, 'A+'));
    await ok(await setGroup(source, 'B+', 'Re-tested'));
    await merge(target, source);

    const merged = await groupOf(target);
    expect(merged.bloodGroup).toBe('B+');
    expect(merged.history.map((e) => [e.bloodGroup, e.fromPatientId])).toEqual([
      ['B+', source],
      ['A+', source],
    ]);
    // The same group again writes nothing; another one needs a reason, and is the survivor's own.
    await ok(await setGroup(target, 'B+'));
    expect((await groupOf(target)).history).toHaveLength(2);
    expect(errorOf(await setGroup(target, 'O+'))).toEqual([422, 'reason_required']);
    const after = await ok<Group>(await setGroup(target, 'O+', 'Cord blood typing'));
    expect(after.history[0]).toMatchObject({ bloodGroup: 'O+' });
    expect(after.history[0]!.fromPatientId).toBeUndefined();
    // Nothing is written for the record merged away.
    expect(errorOf(await setGroup(source, 'AB+', 'Why'))).toEqual([409, 'patient_merged']);
    // The rows were never moved or copied.
    const rows = await pool.query<{ patient_id: string }>(
      'select patient_id from patient_blood_groups where tenant_id = $1 and patient_id = any($2::uuid[])',
      [hospital.id, [source, target]],
    );
    expect(rows.rows.filter((r) => r.patient_id === source)).toHaveLength(2);
    expect(rows.rows).toHaveLength(3);

    await unmerge(source);
    expect((await groupOf(source)).history.map((e) => e.bloodGroup)).toEqual(['B+', 'A+']);
    expect((await groupOf(target)).history.map((e) => e.bloodGroup)).toEqual(['O+']);
  });

  it('follows a chain of merges and keeps the append-only guard', async () => {
    const top = await patient(hospital);
    const middle = await patient(hospital);
    const bottom = await patient(hospital);
    await ok(await setGroup(bottom, 'AB-'));
    await merge(middle, bottom);
    await merge(top, middle);
    expect((await groupOf(top)).history.map((e) => [e.bloodGroup, e.fromPatientId])).toEqual([
      ['AB-', bottom],
    ]);
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query("update patient_blood_groups set blood_group = 'O+' where patient_id = $1", [
          bottom,
        ]),
      ).rejects.toThrow();
    });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('delete from patient_blood_groups where patient_id = $1', [bottom]),
      ).rejects.toThrow();
    });
  });

  it('shows nothing of another hospital', async () => {
    const target = await patient(hospital);
    const source = await patient(hospital);
    await ok(await setGroup(source, 'A-'));
    await merge(target, source);
    const foreign = await patient(clinic);
    await ok(
      await post(`/patients/${foreign}/blood-group`, { bloodGroup: 'O-' }, clinic, clinicAdmin),
    );
    expect(errorOf(await get(`/patients/${target}/blood-group`, clinic, clinicAdmin))).toEqual([
      422,
      'unknown_patient',
    ]);
    const seen = await asTenantSql(pool, clinic.id, (client) =>
      client.query<{ id: string }>('select id from merged_family($1::uuid)', [target]),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([target]);
  });
});

describe('cross-matches and a patient merge', () => {
  it('a cross-match made for the merged-away record counts for the survivor, until unmerged', async () => {
    const target = await patient(hospital);
    const source = await patient(hospital);
    await ok(await setGroup(source, 'O+'));
    await ok(await setGroup(target, 'O+'));
    const viaRoute = await availableUnit();
    const viaSql = await availableUnit();
    await ok(await crossmatch(viaRoute, source), 201);
    await ok(await crossmatch(viaSql, source), 201);
    expect(errorOf(await reserve(viaRoute, target))).toEqual([409, 'crossmatch_required']);

    await merge(target, source);
    const listed = await ok<Listed>(
      await post('/blood/compatible-units', { patientId: target, component: 'red_cells' }),
    );
    expect(listed.items.find((i) => i.unit.id === viaRoute.id)?.crossmatchValid).toBe(true);
    expect(await ok<Unit>(await reserve(viaRoute, target))).toMatchObject({ status: 'reserved' });
    // The database guard counts it too.
    await pool.query("update blood_units set status = 'reserved', patient_id = $2 where id = $1", [
      viaSql.id,
      target,
    ]);

    await unmerge(source);
    const again = await availableUnit();
    await ok(await crossmatch(again, source), 201);
    expect(errorOf(await reserve(again, target))).toEqual([409, 'crossmatch_required']);
    const after = await ok<Listed>(
      await post('/blood/compatible-units', { patientId: target, component: 'red_cells' }),
    );
    expect(after.items.find((i) => i.unit.id === again.id)?.crossmatchValid).toBe(false);
  });
});
