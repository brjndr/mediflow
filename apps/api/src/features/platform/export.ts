import type pg from 'pg';
import type { FileStore } from '../../core/files/store.js';
import { withPlatformTransaction } from '../../core/platform/db.js';
import { withTenantTransaction } from '../../core/tenancy/transaction.js';
import { csvLine, sha256, TarBuilder } from './archive.js';
import { recordPlatformAudit } from './repository.js';
import { exportedTables, treatmentOf } from './tenant-data.js';

export const EXPORT_JOB = 'platform.export';

/** Ids only: the queue's own table has no row-level security. */
export interface ExportJob {
  exportId: string;
}

/**
 * The archive is built in memory (the file store takes a whole buffer), so it has a ceiling. A
 * hospital past it needs the store to take a stream first: the run ends `too_large`.
 */
export const EXPORT_MAX_BYTES = 1_500_000_000;
/** A run silent for this long was left by a worker that stopped; the next delivery takes it. */
const STALE_MINUTES = 120;
const BATCH = 2000;

export const exportKeyOf = (hospitalId: string, exportId: string): string =>
  `exports/${hospitalId}/${exportId}.tar`;

class TooLarge extends Error {}

/**
 * Queues an export for an offboarding hospital, inside the caller's platform transaction. Returns
 * the new row's id, or null when one is already queued or running.
 */
export async function createExport(
  client: pg.ClientBase,
  hospitalId: string,
  requestedBy: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `insert into tenant_exports (hospital_id, requested_by) values ($1, $2)
     on conflict (hospital_id) where status in ('queued', 'running') do nothing
     returning id`,
    [hospitalId, requestedBy],
  );
  return rows[0]?.id ?? null;
}

interface Claimed {
  hospitalId: string;
  requestedBy: string;
}

async function claim(pool: pg.Pool, exportId: string): Promise<Claimed | null> {
  return withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{ hospital_id: string; requested_by: string }>(
      `update tenant_exports set status = 'running', started_at = now()
       where id = $1
         and (status = 'queued'
              or (status = 'running' and started_at < now() - make_interval(mins => $2)))
       returning hospital_id, requested_by`,
      [exportId, STALE_MINUTES],
    );
    const row = rows[0];
    if (!row) return null;
    const hospital = await client.query<{ status: string }>(
      'select status from tenants where id = $1',
      [row.hospital_id],
    );
    if (hospital.rows[0]?.status !== 'offboarding') {
      // Reactivated (or gone) while it waited: nothing to hand over.
      await client.query(
        `update tenant_exports set status = 'failed', failure = 'not_offboarding', finished_at = now()
         where id = $1`,
        [exportId],
      );
      return null;
    }
    return { hospitalId: row.hospital_id, requestedBy: row.requested_by };
  });
}

interface TableResult {
  table: string;
  file: string;
  rows: number;
  sha256: string;
}
interface FileEntry {
  table: string;
  key: string;
  file: string;
  bytes: number;
  sha256: string;
}

/** Every row of one table of the hospital, as a CSV, read in batches through a cursor. */
async function readTable(
  client: pg.PoolClient,
  table: string,
  omit: string[],
  fileColumn: string | undefined,
  fileKeys: string[],
): Promise<{ csv: Buffer; rows: number }> {
  const { rows: columns } = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  const names = columns.map((c) => c.column_name).filter((name) => !omit.includes(name));
  const lines: string[] = [csvLine(names)];
  let count = 0;
  // The table's name comes from the registry, never from a request.
  await client.query(
    `declare export_cur no scroll cursor for select to_jsonb(t) as r from "${table}" t`,
  );
  for (;;) {
    const { rows } = await client.query<{ r: Record<string, unknown> }>(
      `fetch forward ${BATCH} from export_cur`,
    );
    if (rows.length === 0) break;
    for (const { r } of rows) {
      lines.push(csvLine(names.map((name) => r[name])));
      const key = fileColumn ? r[fileColumn] : null;
      if (typeof key === 'string') fileKeys.push(key);
      count += 1;
    }
  }
  await client.query('close export_cur');
  return { csv: Buffer.from(lines.join(''), 'utf8'), rows: count };
}

/** Failure codes only: never the database's own text, which can quote data. */
const failureCode = (error: unknown): string =>
  error instanceof TooLarge ? 'too_large' : 'failed';

/**
 * Makes one hospital's export: every exported table (`tenant-data.ts`) as a CSV, the hospital's
 * own audit log among them, its stored files as they are, and a manifest with a checksum for each,
 * as one tar archive in the file store. Reads as the hospital (the app role with the tenant set),
 * so row-level security is what keeps another hospital's rows out. A run that fails is marked
 * `failed` with a code and not retried by itself: the platform asks again. Safe to deliver twice:
 * the claim lets one delivery work, and the file's key is the export's own.
 */
export async function runExport(
  pool: pg.Pool,
  files: FileStore,
  job: ExportJob,
): Promise<'made' | 'skipped' | 'failed'> {
  const claimed = await claim(pool, job.exportId);
  if (!claimed) return 'skipped';
  const { hospitalId, requestedBy } = claimed;
  const key = exportKeyOf(hospitalId, job.exportId);
  try {
    const tar = new TarBuilder();
    const tables: TableResult[] = [];
    const stored: FileEntry[] = [];
    const missing: { table: string; key: string }[] = [];
    const fileKeys: { table: string; key: string }[] = [];

    await withTenantTransaction(
      pool,
      hospitalId,
      async (client) => {
        for (const table of exportedTables()) {
          const treatment = treatmentOf(table);
          const keys: string[] = [];
          const { csv, rows } = await readTable(
            client,
            table,
            treatment.omit ?? [],
            treatment.fileKey,
            keys,
          );
          const name = `tables/${table}.csv`;
          tar.add(name, csv);
          tables.push({ table, file: name, rows, sha256: sha256(csv) });
          for (const k of keys) fileKeys.push({ table, key: k });
          if (tar.bytes > EXPORT_MAX_BYTES) throw new TooLarge();
        }
        // The people the rows name (the author of a note, the user behind an audit entry).
        const staff = await client.query<{ r: Record<string, unknown> }>(
          `select jsonb_build_object('user_id', u.id, 'name', u.name, 'email', u.email,
                                     'role_id', m.role_id, 'status', m.status) as r
           from memberships m join users u on u.id = m.user_id order by u.name, u.id`,
        );
        const staffNames = ['user_id', 'name', 'email', 'role_id', 'status'];
        const staffCsv = Buffer.from(
          csvLine(staffNames) +
            staff.rows.map(({ r }) => csvLine(staffNames.map((n) => r[n]))).join(''),
          'utf8',
        );
        tar.add('tables/_staff.csv', staffCsv);
        tables.push({
          table: '_staff',
          file: 'tables/_staff.csv',
          rows: staff.rows.length,
          sha256: sha256(staffCsv),
        });
        const hospital = await client.query<{ r: unknown }>(
          `select to_jsonb(t) as r from (
             select id, slug, name, locale, timezone, currency, address, phone, registration_number,
                    gstin, region, created_at, offboarding_requested_at, delete_after
             from tenants where id = app_tenant_id()) t`,
        );
        const hospitalJson = Buffer.from(
          JSON.stringify(hospital.rows[0]?.r ?? null, null, 2),
          'utf8',
        );
        tar.add('hospital.json', hospitalJson);
        tables.push({
          table: '_hospital',
          file: 'hospital.json',
          rows: 1,
          sha256: sha256(hospitalJson),
        });
      },
      { readOnly: true },
    );

    for (const { table, key: fileKey } of fileKeys) {
      const data = await files.get(fileKey);
      if (!data) {
        missing.push({ table, key: fileKey });
        continue;
      }
      const name = `files/${fileKey}`;
      tar.add(name, data);
      stored.push({ table, key: fileKey, file: name, bytes: data.length, sha256: sha256(data) });
      if (tar.bytes > EXPORT_MAX_BYTES) throw new TooLarge();
    }

    const manifest = Buffer.from(
      JSON.stringify(
        {
          format: 'mediflow-hospital-export/1',
          hospitalId,
          exportId: job.exportId,
          madeAt: new Date().toISOString(),
          notes:
            'One CSV for each table (a null is an empty cell, a JSON value is written as JSON), the audit log among them, and the stored files as they are under files/. Every entry has its SHA-256 here. The law makes the hospital responsible for keeping its own medical, billing and drug records for their minimum periods: keep this archive.',
          tables,
          files: stored,
          missingFiles: missing,
        },
        null,
        2,
      ),
      'utf8',
    );
    tar.add('manifest.json', manifest);
    const archive = tar.finish();
    const digest = sha256(archive);

    await files.put(key, archive);
    const rowTotal = tables.reduce((sum, t) => sum + t.rows, 0);
    await withPlatformTransaction(pool, async (client) => {
      await client.query(
        `update tenant_exports
         set status = 'succeeded', finished_at = now(), file_key = $2, file_bytes = $3, sha256 = $4,
             table_count = $5, row_count = $6, file_count = $7
         where id = $1 and status = 'running'`,
        [job.exportId, key, archive.length, digest, tables.length, rowTotal, stored.length],
      );
      await recordPlatformAudit(client, {
        actorId: requestedBy,
        action: 'hospital.export_made',
        entity: 'hospital_export',
        entityId: job.exportId,
        hospitalId,
        detail: {
          tables: tables.length,
          rows: rowTotal,
          files: stored.length,
          missing: missing.length,
        },
      });
    });
    return 'made';
  } catch (error) {
    await files.delete(key).catch(() => undefined);
    const code = failureCode(error);
    await withPlatformTransaction(pool, async (client) => {
      await client.query(
        `update tenant_exports set status = 'failed', failure = $2, finished_at = now()
         where id = $1 and status = 'running'`,
        [job.exportId, code],
      );
      await recordPlatformAudit(client, {
        actorId: requestedBy,
        action: 'hospital.export_failed',
        entity: 'hospital_export',
        entityId: job.exportId,
        hospitalId,
        detail: { failure: code },
      });
    }).catch(() => undefined);
    return 'failed';
  }
}
