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
  deleteUsers,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { MemoryQueue } from '../../core/jobs/queue.js';
import { deletionBlocker, runDeletion } from './deletion.js';
import { deletedTables, deletionOrder } from './tenant-data.js';

/**
 * Deleting an offboarded hospital's data (#961), through the real app and database: the rules that
 * stop it, the second admin, what is gone afterwards in every table and in the file store, and
 * that the other hospital lost nothing.
 */

const queue = new MemoryQueue();
let app: FastifyInstance;
let pool: pg.Pool;
let first: TestUser;
let second: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let adminC: TestUser;
let hospitalA: TestTenant;
let hospitalB: TestTenant;
let hospitalC: TestTenant;
const users: TestUser[] = [];

const OFFBOARD = `update tenants set status = 'offboarding', offboarding_requested_at = now(),
  delete_after = now() + make_interval(days => $2) where id = $1`;
const call = (method: 'GET' | 'POST', url: string, asUser = first.id, payload?: object) =>
  app.inject({ method, url, headers: as(null, asUser), ...(payload ? { payload } : {}) });
const code = (response: { json: () => { error: { code: string } } }) => response.json().error.code;
const deletionUrl = (tenant: TestTenant) => `/platform/hospitals/${tenant.id}/deletion`;

async function platformAdmin(name: string): Promise<TestUser> {
  const user = await createUser(pool, name);
  await pool.query('update users set is_platform_admin = true where id = $1', [user.id]);
  await pool.query(
    "insert into user_mfa (user_id, secret_encrypted, confirmed_at) values ($1, '\\x00', now())",
    [user.id],
  );
  users.push(user);
  return user;
}

const seeds = new Map<string, { patientId: string; reportKey: string }>();

async function seedHospital(tenant: TestTenant, admin: TestUser, label: string) {
  await addMembership(pool, admin, tenant, 'admin');
  await pool.query('insert into departments (tenant_id, name) values ($1, $2)', [
    tenant.id,
    `${label} Cardiology`,
  ]);
  const patient = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Patient', '1980-05-01', 'female', '+91 9800000000', $4) returning id`,
    [tenant.id, `DL-${tenant.id.slice(0, 6)}`, label, admin.id],
  );
  await pool.query(
    `insert into audit_log (tenant_id, actor_id, action, entity, entity_id)
     values ($1, $2, 'read', 'patient', $3)`,
    [tenant.id, admin.id, patient.rows[0]?.id],
  );
  const reportId = randomUUID();
  const reportKey = `reports/${tenant.id}/${reportId}.csv`;
  await pool.query(
    `insert into report_runs (id, tenant_id, kind, status, requested_by, finished_at, row_count,
       result, file_key, expires_at)
     values ($1, $2, 'stock', 'succeeded', $3, now(), 0, '{}', $4, now() + interval '1 day')`,
    [reportId, tenant.id, admin.id, reportKey],
  );
  await app.files.put(reportKey, Buffer.from(`${label} report`));
  seeds.set(tenant.id, { patientId: patient.rows[0]?.id as string, reportKey });
}

/** Rows of the hospital in every table the deletion covers. */
async function counts(tenant: TestTenant): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of deletedTables()) {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from "${table}" where tenant_id = $1`,
      [tenant.id],
    );
    result[table] = Number(rows[0]?.n);
  }
  return result;
}

const placeHold = (tenant: TestTenant, by: TestUser) =>
  pool.query(
    `insert into document_legal_holds (tenant_id, patient_id, reason, placed_by)
     values ($1, $2, 'Inquiry', $3)`,
    [tenant.id, seeds.get(tenant.id)?.patientId, by.id],
  );
const releaseHolds = (tenant: TestTenant, by: TestUser) =>
  pool.query(
    'update document_legal_holds set released_at = now(), released_by = $2 where tenant_id = $1',
    [tenant.id, by.id],
  );

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession, jobQueue: queue });
  pool = app.database.pool;
  first = await platformAdmin('Delete Operator One');
  second = await platformAdmin('Delete Operator Two');
  adminA = await createUser(pool, 'Admin Alpha');
  adminB = await createUser(pool, 'Admin Beta');
  adminC = await createUser(pool, 'Admin Gamma');
  users.push(adminA, adminB, adminC);
  hospitalA = await createTenant(pool, 'Delete Alpha');
  hospitalB = await createTenant(pool, 'Delete Beta');
  hospitalC = await createTenant(pool, 'Delete Gamma');
  await seedHospital(hospitalA, adminA, 'Alpha');
  await seedHospital(hospitalB, adminB, 'Beta');
  await seedHospital(hospitalC, adminC, 'Gamma');
});

afterAll(async () => {
  const ids = [hospitalA.id, hospitalB.id, hospitalC.id];
  await pool.query('delete from tenant_exports where hospital_id = any($1::uuid[])', [ids]);
  await pool.query('delete from tenant_deletions where hospital_id = any($1::uuid[])', [ids]);
  // The same way the job deletes: the append-only triggers are off for this transaction.
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of deletedTables()) {
      await client.query(`delete from "${table}" where tenant_id = any($1::uuid[])`, [ids]);
    }
    await client.query('delete from tenants where id = any($1::uuid[])', [ids]);
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, users);
  await app.close();
});

describe('the order of deletion', () => {
  it('puts a table after every table that points at it, and keeps a cycle at the end', () => {
    const order = deletionOrder(
      ['a', 'b', 'c', 'd', 'e'],
      [
        { child: 'b', parent: 'a' },
        { child: 'c', parent: 'b' },
        { child: 'a', parent: 'a' },
        { child: 'x', parent: 'a' },
        { child: 'd', parent: 'e' },
        { child: 'e', parent: 'd' },
      ],
    );
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
    expect(order.slice(-2)).toEqual(['d', 'e']);
    expect(order).toHaveLength(5);
  });

  it('covers the catalog of tenant tables with the real foreign keys', async () => {
    const refs = await pool.query<{ child: string; parent: string }>(
      `select c.relname as child, p.relname as parent
       from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class p on p.oid = k.confrelid
       where k.contype = 'f' and c.relnamespace = 'public'::regnamespace`,
    );
    const order = deletionOrder(deletedTables(), refs.rows);
    expect([...order].sort()).toEqual(deletedTables());
    // Children first, wherever the catalog says so.
    for (const { child, parent } of refs.rows) {
      if (child === parent || !order.includes(child) || !order.includes(parent)) continue;
      expect(order.indexOf(child), `${child} before ${parent}`).toBeLessThan(order.indexOf(parent));
    }
  });
});

describe('asking for a deletion', () => {
  it('needs an offboarding hospital, the grace period over and an export or a waiver', async () => {
    const notOffboarding = await call('POST', deletionUrl(hospitalA), first.id, {
      waiverReference: 'W-1',
    });
    expect(notOffboarding.statusCode).toBe(409);
    expect(code(notOffboarding)).toBe('hospital_not_offboarding');

    await pool.query(OFFBOARD, [hospitalA.id, 90]);
    const early = await call('POST', deletionUrl(hospitalA), first.id, { waiverReference: 'W-1' });
    expect(code(early)).toBe('grace_period_not_over');

    await pool.query(
      "update tenants set delete_after = now() - interval '1 minute' where id = $1",
      [hospitalA.id],
    );
    const noExport = await call('POST', deletionUrl(hospitalA), first.id, {});
    expect(code(noExport)).toBe('export_not_downloaded');

    // An export that was made but not downloaded does not count.
    await call('POST', `/platform/hospitals/${hospitalA.id}/exports`);
    await queue.drain();
    const made = await pool.query<{ id: string }>(
      "select id from tenant_exports where hospital_id = $1 and status = 'succeeded'",
      [hospitalA.id],
    );
    expect(made.rowCount).toBe(1);
    expect(code(await call('POST', deletionUrl(hospitalA), first.id, {}))).toBe(
      'export_not_downloaded',
    );
  });

  it('is refused while a legal hold or an open medico-legal case exists', async () => {
    await pool.query(
      'update tenant_exports set first_downloaded_at = now(), download_count = 1 where hospital_id = $1',
      [hospitalA.id],
    );
    await placeHold(hospitalA, adminA);
    expect(code(await call('POST', deletionUrl(hospitalA), first.id, {}))).toBe('legal_hold');
    await releaseHolds(hospitalA, adminA);

    const caseId = randomUUID();
    await pool.query(
      `insert into er_encounters (id, tenant_id, temp_no, complaint, arrival_mode, created_by)
       values ($1, $2, 1, 'Injury', 'police', $3)`,
      [caseId, hospitalA.id, adminA.id],
    );
    await pool.query(
      `insert into er_medico_legal (tenant_id, case_id, revision, category, narrative, police_informed, recorded_by)
       values ($1, $2, 1, 'assault', 'Account', false, $3)`,
      [hospitalA.id, caseId, adminA.id],
    );
    expect(code(await call('POST', deletionUrl(hospitalA), first.id, {}))).toBe(
      'medico_legal_open',
    );
    await pool.query(
      `update er_encounters set status = 'disposed', disposition = 'discharge', disposed_at = now(),
         disposed_by = $2 where id = $1`,
      [caseId, adminA.id],
    );
    expect(
      await deletionBlocker(pool, hospitalA.id, {
        exportId: (
          await pool.query<{ id: string }>('select id from tenant_exports where hospital_id = $1', [
            hospitalA.id,
          ])
        ).rows[0]?.id as string,
        waiverReference: null,
      }),
    ).toBeNull();
  });
});

describe('the deletion of a hospital', () => {
  it('waits for a second platform admin, then deletes that hospital and nothing else', async () => {
    const before = await counts(hospitalB);
    const beforeA = await counts(hospitalA);
    for (const table of ['departments', 'patients', 'audit_log', 'report_runs', 'memberships']) {
      expect(beforeA[table], table).toBeGreaterThan(0);
      expect(before[table], table).toBeGreaterThan(0);
    }

    const requested = await call('POST', deletionUrl(hospitalA), first.id, {});
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toMatchObject({ status: 'requested', basis: 'export' });
    expect(code(await call('POST', deletionUrl(hospitalA), first.id, {}))).toBe(
      'deletion_in_progress',
    );
    // Nothing is deleted until someone else approves, and the one who asked cannot.
    expect(code(await call('POST', `${deletionUrl(hospitalA)}/approve`, first.id))).toBe(
      'approver_must_differ',
    );
    await queue.drain();
    expect((await counts(hospitalA)).departments).toBe(1);

    // A hold placed after the request stops the approval, which checks again.
    await placeHold(hospitalA, adminA);
    expect(code(await call('POST', `${deletionUrl(hospitalA)}/approve`, second.id))).toBe(
      'legal_hold',
    );
    await releaseHolds(hospitalA, adminA);

    const approved = await call('POST', `${deletionUrl(hospitalA)}/approve`, second.id);
    expect(approved.statusCode).toBe(202);
    expect(approved.json()).toMatchObject({ status: 'approved', approvedBy: second.id });
    await queue.drain();

    const done = (await call('GET', deletionUrl(hospitalA))).json();
    expect(done).toMatchObject({ status: 'done', failure: null });
    expect(done.rowCount).toBeGreaterThan(0);
    expect(done.fileCount).toBe(2);

    // Every table: nothing of the hospital is left.
    const after = await counts(hospitalA);
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);
    // The other hospital: every table as it was.
    expect(await counts(hospitalB)).toEqual(before);
    // Files: the hospital's report and its export are gone, the other's is not.
    expect(await app.files.get(seeds.get(hospitalA.id)?.reportKey as string)).toBeNull();
    const archive = await pool.query<{ file_key: string }>(
      'select file_key from tenant_exports where hospital_id = $1',
      [hospitalA.id],
    );
    expect(await app.files.get(archive.rows[0]?.file_key as string)).toBeNull();
    expect((await app.files.get(seeds.get(hospitalB.id)?.reportKey as string))?.toString()).toBe(
      'Beta report',
    );
  });

  it('leaves a tombstone and the platform trail, and the hospital cannot be reopened', async () => {
    const { rows } = await pool.query(
      `select status, name, deleted_at, address, phone, registration_number, gstin, delete_after
       from tenants where id = $1`,
      [hospitalA.id],
    );
    expect(rows[0]).toMatchObject({
      status: 'deleted',
      name: 'Delete Alpha',
      address: null,
      phone: null,
      registration_number: null,
      gstin: null,
      delete_after: null,
    });
    expect(rows[0].deleted_at).toBeInstanceOf(Date);
    const trail = await pool.query<{ action: string }>(
      "select action from platform_audit_log where hospital_id = $1 and entity = 'hospital_deletion' order by at, id",
      [hospitalA.id],
    );
    expect(trail.rows.map((r) => r.action)).toEqual([
      'hospital.deletion_requested',
      'hospital.deletion_approved',
      'hospital.deletion_started',
      'hospital.deletion_files_deleted',
      'hospital.deleted',
    ]);
    const exports = await pool.query('select 1 from tenant_exports where hospital_id = $1', [
      hospitalA.id,
    ]);
    expect(exports.rowCount).toBe(1);

    const reopened = await call('POST', `/platform/hospitals/${hospitalA.id}/reactivate`);
    expect(reopened.statusCode).toBe(409);
    const listed = await call('GET', `/platform/hospitals/${hospitalA.id}`);
    expect(listed.json().status).toBe('deleted');
  });

  it('is not delivered twice', async () => {
    const id = (
      await pool.query<{ id: string }>('select id from tenant_deletions where hospital_id = $1', [
        hospitalA.id,
      ])
    ).rows[0]?.id as string;
    expect(await runDeletion(pool, app.files, { deletionId: id })).toBe('skipped');
  });
});

describe('a deletion that does not go ahead', () => {
  it('is cancelled by reactivating the hospital', async () => {
    await pool.query(OFFBOARD, [hospitalC.id, 0]);
    const requested = await call('POST', deletionUrl(hospitalC), first.id, {
      waiverReference: 'Waiver 2026/7',
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toMatchObject({ basis: 'waiver', waiverReference: 'Waiver 2026/7' });
    await call('POST', `${deletionUrl(hospitalC)}/approve`, second.id);

    const reactivated = await call('POST', `/platform/hospitals/${hospitalC.id}/reactivate`);
    expect(reactivated.statusCode).toBe(200);
    await queue.drain();
    expect((await call('GET', deletionUrl(hospitalC))).json().status).toBe('cancelled');
    expect((await counts(hospitalC)).departments).toBe(1);
    const trail = await pool.query(
      "select detail from platform_audit_log where hospital_id = $1 and action = 'hospital.deletion_cancelled'",
      [hospitalC.id],
    );
    expect(trail.rows[0]?.detail).toEqual({ reason: 'reactivated' });
  });

  it('can be withdrawn before it starts, and a hold placed before the run stops it', async () => {
    await pool.query(OFFBOARD, [hospitalC.id, 0]);
    await call('POST', deletionUrl(hospitalC), first.id, { waiverReference: 'W-2' });
    const cancelled = await call('POST', `${deletionUrl(hospitalC)}/cancel`, second.id);
    expect(cancelled.json().status).toBe('cancelled');

    await call('POST', deletionUrl(hospitalC), first.id, { waiverReference: 'W-3' });
    await call('POST', `${deletionUrl(hospitalC)}/approve`, second.id);
    await placeHold(hospitalC, adminC);
    await queue.drain();
    const row = (await call('GET', deletionUrl(hospitalC))).json();
    expect(row).toMatchObject({ status: 'failed', failure: 'legal_hold' });
    const after = await counts(hospitalC);
    expect(after.departments).toBe(1);
    expect(after.patients).toBe(1);
    expect((await app.files.get(seeds.get(hospitalC.id)?.reportKey as string))?.toString()).toBe(
      'Gamma report',
    );
    const status = await pool.query('select status from tenants where id = $1', [hospitalC.id]);
    expect(status.rows[0]?.status).toBe('offboarding');
  });

  it('needs a platform admin, and answers 404 for a hospital with none requested', async () => {
    const staff = await call('GET', deletionUrl(hospitalB), adminB.id);
    expect(staff.statusCode).toBe(403);
    const none = await call('GET', deletionUrl(hospitalB));
    expect(none.statusCode).toBe(404);
    expect(code(none)).toBe('no_deletion');
  });
});
