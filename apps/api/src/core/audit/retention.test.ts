import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, deleteTenants, testConfig, type TestTenant } from '../../../test/helpers.js';
import type { FileStore } from '../files/store.js';
import { retentionCutoff, retireAuditPartitions } from './retention.js';

let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;

function memoryStore(failPut = false, corrupt = false): FileStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(key, data) {
      if (failPut) throw new Error('disk_full');
      files.set(key, data);
    },
    async get(key) {
      if (corrupt) return Buffer.from('not what was written');
      return files.get(key) ?? null;
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

async function partitionExists(month: string): Promise<boolean> {
  const { rows } = await pool.query<{ r: string | null }>('select to_regclass($1) as r', [
    `audit_log_${month.slice(0, 7).replace('-', '_')}`,
  ]);
  return rows[0]?.r != null;
}

async function seedMonth(month: string, tenants: TestTenant[]): Promise<void> {
  await pool.query('select ensure_audit_partition($1::date)', [month]);
  for (const t of tenants) {
    await pool.query(
      `insert into audit_log (tenant_id, at, action, entity)
       values ($1, $2::date + interval '3 days', 'read', 'patient'),
              ($1, $2::date + interval '9 days', 'update', 'patient')`,
      [t.id, month],
    );
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: testConfig().DATABASE_URL });
  // A run that stopped half way leaves 2015 partitions and archive rows behind.
  const { rows: stale } = await pool.query<{ relname: string }>(
    "select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'audit_log'::regclass and c.relname like 'audit_log_2015_%'",
  );
  for (const { relname } of stale) await pool.query(`drop table ${relname}`);
  await pool.query("delete from audit_archives where month < '2016-01-01'");
  hospital = await createTenant(pool, 'Audit retention A');
  clinic = await createTenant(pool, 'Audit retention B');
});

afterAll(async () => {
  await pool.query('delete from audit_archives where month in ($1, $2)', [
    '2015-03-01',
    '2015-04-01',
  ]);
  await deleteTenants(pool, [hospital, clinic]);
  await pool.end();
});

describe('audit log retention', () => {
  it('computes the first kept month', () => {
    expect(retentionCutoff(new Date('2026-11-19T10:00:00Z'), 36)).toBe('2023-11-01');
    expect(retentionCutoff(new Date('2026-02-05T00:00:00Z'), 36)).toBe('2023-02-01');
  });

  it('archives an old month of every hospital, then drops its partition', async () => {
    await seedMonth('2015-03-01', [hospital, clinic]);
    const store = memoryStore();
    const retired = await retireAuditPartitions(pool, store, 36);
    expect(retired).toContain('2015-03-01');
    expect(await partitionExists('2015-03-01')).toBe(false);

    const { rows } = await pool.query<{
      row_count: string;
      parts: { key: string; rows: number; sha256: string }[];
    }>("select row_count, parts from audit_archives where month = '2015-03-01'");
    expect(Number(rows[0]!.row_count)).toBe(4);
    const lines = gunzipSync(store.files.get(rows[0]!.parts[0]!.key)!)
      .toString()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { tenant_id: string });
    expect(new Set(lines.map((l) => l.tenant_id))).toEqual(new Set([hospital.id, clinic.id]));
  });

  it('keeps a month inside the period and the default partition', async () => {
    const recent = new Date();
    const month = new Date(Date.UTC(recent.getUTCFullYear(), recent.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const store = memoryStore();
    const retired = await retireAuditPartitions(pool, store, 36);
    expect(retired).not.toContain(month);
    expect(await partitionExists(month)).toBe(true);
    const { rows } = await pool.query("select to_regclass('audit_log_default') as r");
    expect(rows[0]?.r).not.toBeNull();
  });

  it('keeps the partition when the archive cannot be written', async () => {
    await seedMonth('2015-04-01', [hospital]);
    await expect(retireAuditPartitions(pool, memoryStore(true), 36)).rejects.toThrow(
      /audit_retention_failed:2015-04-01/,
    );
    expect(await partitionExists('2015-04-01')).toBe(true);
    await retireAuditPartitions(pool, memoryStore(), 36);
    expect(await partitionExists('2015-04-01')).toBe(false);
  });

  it('keeps the partition when the stored file does not match, and when it changed', async () => {
    await seedMonth('2015-06-01', [hospital]);
    await expect(retireAuditPartitions(pool, memoryStore(false, true), 36)).rejects.toThrow(
      /audit_retention_failed:.*2015-06-01/,
    );
    expect(await partitionExists('2015-06-01')).toBe(true);
    const { rowCount } = await pool.query(
      "select 1 from audit_archives where month = '2015-06-01'",
    );
    expect(rowCount).toBe(0);
    await retireAuditPartitions(pool, memoryStore(), 36);
    expect(await partitionExists('2015-06-01')).toBe(false);
  });

  it('writes a month in several files without losing or repeating a row', async () => {
    await seedMonth('2015-07-01', [hospital, clinic, hospital]);
    const store = memoryStore();
    await retireAuditPartitions(pool, store, 36, { pageSize: 4 });
    const { rows } = await pool.query<{ parts: { key: string; rows: number }[] }>(
      "select parts from audit_archives where month = '2015-07-01'",
    );
    const parts = rows[0]!.parts;
    expect(parts.map((p) => p.rows)).toEqual([4, 2]);
    expect(parts[1]!.key).toMatch(/part-0002/);
    const ids = parts.flatMap((p) =>
      gunzipSync(store.files.get(p.key)!)
        .toString()
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { id: string }).id),
    );
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('keeps going past a failed month, then reports it', async () => {
    await seedMonth('2015-08-01', [hospital]);
    await seedMonth('2015-09-01', [hospital]);
    const failures: string[] = [];
    const store = memoryStore();
    const put = store.put.bind(store);
    store.put = async (key, data) => {
      if (key.includes('2015-08')) throw new Error('disk_full');
      return put(key, data);
    };
    await expect(
      retireAuditPartitions(pool, store, 36, { onFailure: (m) => failures.push(m) }),
    ).rejects.toThrow(/2015-08-01/);
    expect(failures).toEqual(['2015-08-01']);
    expect(await partitionExists('2015-08-01')).toBe(true);
    expect(await partitionExists('2015-09-01')).toBe(false);
    await retireAuditPartitions(pool, memoryStore(), 36);
  });

  it('archives an empty month as nothing and drops it', async () => {
    await pool.query("select ensure_audit_partition('2015-10-01')");
    await retireAuditPartitions(pool, memoryStore(), 36);
    expect(await partitionExists('2015-10-01')).toBe(false);
    const { rows } = await pool.query(
      "select row_count from audit_archives where month = '2015-10-01'",
    );
    expect(Number(rows[0].row_count)).toBe(0);
  });

  it('refuses to drop a month that gained rows after it was archived', async () => {
    await seedMonth('2015-11-01', [hospital]);
    await pool.query(
      "insert into audit_archives (month, row_count, parts) values ('2015-11-01', 1, '[]')",
    );
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_worker');
      await expect(
        client.query("select audit_retire_partition('2015-11-01', '2023-01-01')"),
      ).rejects.toThrow(/changed since/);
    } finally {
      await client.query('rollback');
      client.release();
    }
    await pool.query('drop table audit_log_2015_11');
  });

  it('refuses to retire a month that is unarchived or inside the period, and a tenant login', async () => {
    await pool.query('select ensure_audit_partition($1::date)', ['2015-05-01']);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_worker');
      await expect(
        client.query("select audit_retire_partition('2015-05-01', '2023-01-01')"),
      ).rejects.toThrow(/not archived/);
      await client.query('rollback');
      await client.query('begin');
      await client.query('set local role mediflow_worker');
      await expect(
        client.query("select audit_retire_partition('2030-01-01', '2023-01-01')"),
      ).rejects.toThrow(/retention period/);
      await client.query('rollback');
      await client.query('begin');
      await client.query('set local role mediflow_app');
      await expect(
        client.query("select audit_retire_partition('2015-05-01', '2023-01-01')"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback');
      client.release();
    }
    await pool.query('drop table audit_log_2015_05');
  });
});
