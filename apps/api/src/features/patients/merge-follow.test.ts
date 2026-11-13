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

/** Clinical rows follow a patient merge on reads and a merged record takes no new rows (#557). */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let admin: TestUser;
const ids = { target: '', source: '' };

async function patient(mrn: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Merge', 'Follow', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [hospital.id, mrn],
  );
  return rows[0]!.id;
}
const openEncounter = (patientId: string) =>
  pool.query(
    `insert into encounters (tenant_id, patient_id, type, opened_by)
     values ($1, $2, 'opd', $3)`,
    [hospital.id, patientId, admin.id],
  );

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Merge Follow Hospital', {
    features: { patients: true, clinical: true },
  });
  await grantRoleDefaults(app, hospital);
  admin = await createUser(pool, 'Merge Follow Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  ids.target = await patient('MF-0000001');
  ids.source = await patient('MF-0000002');
}, 60_000);

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of ['encounters', 'patient_merges', 'outbox', 'patients']) {
      await client.query(`delete from ${table} where tenant_id = $1`, [hospital.id]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital]);
  await deleteUsers(pool, [admin]);
  await app.close();
});

describe('merged patients in the clinical modules', () => {
  it('shows the merged history on the survivor and refuses new rows for the source', async () => {
    await openEncounter(ids.source);
    const version = async (id: string) =>
      (await pool.query<{ version: number }>('select version from patients where id = $1', [id]))
        .rows[0]!.version;
    const merged = await app.inject({
      method: 'POST',
      url: `/patients/${ids.target}/merge`,
      headers: { ...as(hospital.id, admin.id), 'idempotency-key': randomUUID() },
      payload: {
        sourcePatientId: ids.source,
        reason: 'Duplicate registration',
        expectedVersion: await version(ids.target),
        expectedSourceVersion: await version(ids.source),
      },
    });
    expect(merged.statusCode).toBe(201);

    const timeline = await app.inject({
      url: `/encounters?patientId=${ids.target}`,
      headers: as(hospital.id, admin.id),
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json<{ items: { patientId: string }[] }>().items).toEqual([
      expect.objectContaining({ patientId: ids.source }),
    ]);

    await expect(openEncounter(ids.source)).rejects.toMatchObject({ code: 'PM409' });
    await expect(openEncounter(ids.target)).resolves.toBeTruthy();
  });

  it('has the guard on every table that keeps a patient_id', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema
         and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema = 'public' and c.column_name = 'patient_id'
         and exists (select 1 from information_schema.columns k where k.table_schema = 'public'
           and k.table_name = c.table_name and k.column_name = 'tenant_id')
         and c.table_name not in ('patient_merges', 'patient_documents', 'document_legal_holds')
         and not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || c.table_name)::regclass
           and g.tgname = 'refuse_merged_patient')`,
    );
    expect(rows).toEqual([]);
  });
});
