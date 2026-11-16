import { createHash, randomUUID } from 'node:crypto';
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
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { MemoryQueue } from '../../core/jobs/queue.js';
import { exportKeyOf, runExport } from './export.js';
import { EXPORTED_PLAIN, EXPORTED_SPECIAL, NOT_EXPORTED } from './tenant-data.js';

/**
 * The registry of a hospital's data and the offboarding export (#960), through the real app and
 * database: what is in the archive, that another hospital's rows are not, and the signed link.
 */

const queue = new MemoryQueue();
let app: FastifyInstance;
let pool: pg.Pool;
let operator: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let hospitalA: TestTenant;
let hospitalB: TestTenant;
const users: TestUser[] = [];
const REPORT_KEY = (tenant: TestTenant, id: string) => `reports/${tenant.id}/${id}.csv`;

/** Reads a tar archive into its entries. */
function untar(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length && archive[offset] !== 0) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 135).toString('ascii'), 8);
    // The checksum is of the header with the checksum field as blanks.
    const given = parseInt(header.subarray(148, 154).toString('ascii'), 8);
    const blanks = Buffer.from(header);
    blanks.fill(0x20, 148, 156);
    expect(blanks.reduce((sum, byte) => sum + byte, 0)).toBe(given);
    entries.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const OFFBOARD = `update tenants set status = 'offboarding', offboarding_requested_at = now(),
  delete_after = now() + interval '90 days' where id = $1`;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const call = (method: 'GET' | 'POST', url: string, payload?: object, asUser = operator.id) =>
  app.inject({ method, url, headers: as(null, asUser), ...(payload ? { payload } : {}) });

async function seedHospital(tenant: TestTenant, admin: TestUser, label: string) {
  await addMembership(pool, admin, tenant, 'admin');
  await pool.query('insert into departments (tenant_id, name) values ($1, $2)', [
    tenant.id,
    `${label} Cardiology`,
  ]);
  const id = randomUUID();
  const key = REPORT_KEY(tenant, id);
  await pool.query(
    `insert into report_runs (id, tenant_id, kind, status, requested_by, finished_at, row_count,
       result, file_key, expires_at)
     values ($1, $2, 'stock', 'succeeded', $3, now(), 0, '{}', $4, now() + interval '1 day')`,
    [id, tenant.id, admin.id, key],
  );
  await app.files.put(key, Buffer.from(`${label} report file`));
  return { key };
}

let seededA: { key: string };

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession, jobQueue: queue });
  pool = app.database.pool;
  operator = await createUser(pool, 'Export Operator');
  await pool.query('update users set is_platform_admin = true where id = $1', [operator.id]);
  await pool.query(
    "insert into user_mfa (user_id, secret_encrypted, confirmed_at) values ($1, '\\x00', now())",
    [operator.id],
  );
  adminA = await createUser(pool, 'Admin Alpha');
  adminB = await createUser(pool, 'Admin Beta');
  users.push(operator, adminA, adminB);
  hospitalA = await createTenant(pool, 'Export Alpha');
  hospitalB = await createTenant(pool, 'Export Beta');
  seededA = await seedHospital(hospitalA, adminA, 'Alpha');
  await seedHospital(hospitalB, adminB, 'Beta');
});

afterAll(async () => {
  const ids = [hospitalA.id, hospitalB.id];
  await pool.query('delete from report_runs where tenant_id = any($1::uuid[])', [ids]);
  await pool.query('delete from tenant_exports where hospital_id = any($1::uuid[])', [ids]);
  await pool.query('delete from departments where tenant_id = any($1::uuid[])', [ids]);
  await deleteTenants(pool, [hospitalA, hospitalB]);
  await deleteUsers(pool, users);
  await app.close();
});

describe('the registry of tenant tables', () => {
  it('names every table with a tenant_id, and only tables that exist', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
         and exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)`,
    );
    const actual = rows.map((row) => row.name).sort();
    const registered = [
      ...EXPORTED_PLAIN,
      ...Object.keys(EXPORTED_SPECIAL),
      ...Object.keys(NOT_EXPORTED),
    ].sort();
    expect(registered).toEqual(actual);
    expect(new Set(registered).size).toBe(registered.length);
  });
});

describe('the offboarding export', () => {
  it('cannot be started for a hospital that is not offboarding', async () => {
    const response = await call('POST', `/platform/hospitals/${hospitalA.id}/exports`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('hospital_not_offboarding');
  });

  it('makes one archive of the hospital alone, with a manifest and checksums', async () => {
    await pool.query(OFFBOARD, [hospitalA.id]);
    const started = await call('POST', `/platform/hospitals/${hospitalA.id}/exports`);
    expect(started.statusCode).toBe(202);
    const again = await call('POST', `/platform/hospitals/${hospitalA.id}/exports`);
    expect(again.json().error.code).toBe('export_in_progress');

    await queue.drain();
    const listed = await call('GET', `/platform/hospitals/${hospitalA.id}/exports`);
    const made = listed.json().items[0];
    expect(made).toMatchObject({ status: 'succeeded', failure: null, downloadCount: 0 });
    expect(made.fileCount).toBe(1);

    const archive = await app.files.get(exportKeyOf(hospitalA.id, made.id));
    expect(archive).not.toBeNull();
    expect(sha(archive as Buffer)).toBe(made.sha256);
    const entries = untar(archive as Buffer);

    const departments = entries.get('tables/departments.csv')?.toString('utf8') ?? '';
    expect(departments).toContain('Alpha Cardiology');
    expect(departments).not.toContain('Beta');
    for (const [name, data] of entries) {
      if (name !== 'manifest.json') expect(data.toString('utf8'), name).not.toContain('Beta');
    }
    const staff = entries.get('tables/_staff.csv')?.toString('utf8') ?? '';
    expect(staff).toContain('Admin Alpha');
    expect(staff).not.toContain('Admin Beta');
    expect(entries.get('tables/audit_log.csv')).toBeDefined();
    expect(entries.get('tables/invites.csv')?.toString('utf8')).not.toContain('token_hash');
    expect(entries.get(`files/${seededA.key}`)?.toString('utf8')).toBe('Alpha report file');

    const manifest = JSON.parse((entries.get('manifest.json') as Buffer).toString('utf8'));
    expect(manifest.hospitalId).toBe(hospitalA.id);
    for (const entry of [...manifest.tables, ...manifest.files]) {
      expect(sha(entries.get(entry.file) as Buffer), entry.file).toBe(entry.sha256);
    }
    expect(manifest.missingFiles).toEqual([]);
    const audit = await pool.query(
      "select 1 from platform_audit_log where hospital_id = $1 and action = 'hospital.export_made'",
      [hospitalA.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('is not delivered twice, and a hospital that was reactivated gets none', async () => {
    const [{ id }] = (await call('GET', `/platform/hospitals/${hospitalA.id}/exports`)).json()
      .items;
    expect(await runExport(pool, app.files, { exportId: id })).toBe('skipped');

    await pool.query(OFFBOARD, [hospitalB.id]);
    const started = await call('POST', `/platform/hospitals/${hospitalB.id}/exports`);
    await pool.query(
      "update tenants set status = 'active', offboarding_requested_at = null, delete_after = null where id = $1",
      [hospitalB.id],
    );
    expect(await runExport(pool, app.files, { exportId: started.json().id })).toBe('skipped');
    const row = await pool.query('select status, failure from tenant_exports where id = $1', [
      started.json().id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'failed', failure: 'not_offboarding' });
  });

  it('is handed over by a signed link made for an active admin of that hospital', async () => {
    const [made] = (await call('GET', `/platform/hospitals/${hospitalA.id}/exports`)).json().items;
    const link = `/platform/hospitals/${hospitalA.id}/exports/${made.id}/download-link`;

    const stranger = await call('POST', link, { adminUserId: adminB.id });
    expect(stranger.json().error.code).toBe('not_a_hospital_admin');
    const staff = await call('POST', link, { adminUserId: operator.id });
    expect(staff.statusCode).toBe(409);

    const issued = await call('POST', link, { adminUserId: adminA.id });
    expect(issued.statusCode).toBe(200);
    const { url, expiresAt } = issued.json();
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);

    // Made for adminA: the same signature does not work for anyone else.
    const forged = await app.inject({ method: 'GET', url: url.replace(adminA.id, adminB.id) });
    expect(forged.statusCode).toBe(404);
    const tampered = await app.inject({ method: 'GET', url: `${url}0` });
    expect(tampered.statusCode).toBe(404);

    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-tar');
    expect(sha(response.rawPayload)).toBe(made.sha256);

    const after = (await call('GET', `/platform/hospitals/${hospitalA.id}/exports`)).json()
      .items[0];
    expect(after.downloadCount).toBe(1);
    expect(after.firstDownloadedAt).not.toBeNull();
    const trail = await pool.query(
      `select actor_id from platform_audit_log
       where hospital_id = $1 and action = 'hospital.export_downloaded'`,
      [hospitalA.id],
    );
    expect(trail.rows).toEqual([{ actor_id: adminA.id }]);

    // The admin who loses the role, or a hospital that is reactivated, ends the link.
    await pool.query("update memberships set status = 'suspended' where tenant_id = $1", [
      hospitalA.id,
    ]);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('starts with the offboarding itself', async () => {
    const base = `/platform/hospitals/${hospitalB.id}`;
    const response = await call('POST', `${base}/offboard`, { deleteAfterDays: 90 });
    expect(response.statusCode).toBe(200);
    const [started] = (await call('GET', `${base}/exports`)).json().items;
    expect(started.status).toBe('queued');
    expect(queue.sent.some((job) => job.name === 'platform.export')).toBe(true);
    await queue.drain();
    const [made] = (await call('GET', `${base}/exports`)).json().items;
    expect(made.status).toBe('succeeded');
  });
});
