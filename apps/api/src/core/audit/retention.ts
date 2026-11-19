import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type pg from 'pg';
import type { FileStore } from '../files/store.js';
import { WORKER_ROLE } from '../outbox/dispatcher.js';

const PAGE = 20_000;

interface ArchivePart {
  key: string;
  rows: number;
  sha256: string;
}

/** The first day of the oldest month that is kept: months before it are archived and dropped. */
export function retentionCutoff(now: Date, months: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  return d.toISOString().slice(0, 10);
}

/** The same begin and `SET LOCAL ROLE` sequence as the daily partition job. */
async function asWorker<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Writes one month as gzipped JSON lines, in files of one page, checks each against what was
 * stored, and only then records the month. The record is made once: a month already recorded was
 * complete when it was, and a past month cannot change (the table is append-only).
 */
async function archiveMonth(
  pool: pg.Pool,
  files: FileStore,
  month: string,
  pageSize: number,
): Promise<void> {
  const recorded = await asWorker(pool, async (client) => {
    const { rowCount } = await client.query('select 1 from audit_archives where month = $1', [
      month,
    ]);
    return (rowCount ?? 0) > 0;
  });
  if (recorded) return;

  const parts: ArchivePart[] = [];
  let total = 0;
  let after: string | null = null;
  for (let n = 1; ; n++) {
    const page: { id: string; doc: unknown }[] = await asWorker(pool, async (client) => {
      const { rows } = await client.query<{ id: string; doc: unknown }>(
        'select id, doc from audit_partition_page($1::date, $2::uuid, $3)',
        [month, after, pageSize],
      );
      return rows;
    });
    if (page.length === 0) break;
    const body = gzipSync(Buffer.from(page.map((r) => JSON.stringify(r.doc)).join('\n') + '\n'));
    const key = `audit-archive/${month.slice(0, 7)}/part-${String(n).padStart(4, '0')}.jsonl.gz`;
    await files.put(key, body);
    const stored = await files.get(key);
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (!stored || createHash('sha256').update(stored).digest('hex') !== sha256) {
      throw new Error('audit_archive_verify_failed');
    }
    parts.push({ key, rows: page.length, sha256 });
    total += page.length;
    after = page[page.length - 1]!.id;
    if (page.length < pageSize) break;
  }

  // What was written must be everything the partition holds, counted on its own.
  await asWorker(pool, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      'select audit_partition_count($1::date) as n',
      [month],
    );
    if (Number(rows[0]?.n) !== total) throw new Error('audit_archive_incomplete');
    await client.query('insert into audit_archives (month, row_count, parts) values ($1, $2, $3)', [
      month,
      total,
      JSON.stringify(parts),
    ]);
  });
}

/**
 * Archives each audit partition older than `months` to the file store, verifies the stored files,
 * then drops the partition. A month that fails stays where it is and the others still run; the
 * call throws at the end if any failed. Returns the months retired. Months and counts, never row
 * content, are all that is logged.
 */
export async function retireAuditPartitions(
  pool: pg.Pool,
  files: FileStore,
  months: number,
  options: {
    now?: Date;
    pageSize?: number;
    onFailure?: (month: string, error: Error) => void;
  } = {},
): Promise<string[]> {
  const cutoff = retentionCutoff(options.now ?? new Date(), months);
  const due = await asWorker(pool, async (client) => {
    const { rows } = await client.query<{ month: string }>(
      "select to_char(m, 'YYYY-MM-DD') as month from audit_partitions_before($1::date) m",
      [cutoff],
    );
    return rows.map((r) => r.month);
  });
  const retired: string[] = [];
  const failed: string[] = [];
  for (const month of due) {
    try {
      await archiveMonth(pool, files, month, options.pageSize ?? PAGE);
      await asWorker(pool, (client) =>
        client.query('select audit_retire_partition($1::date, $2::date)', [month, cutoff]),
      );
      retired.push(month);
    } catch (error) {
      failed.push(month);
      options.onFailure?.(month, error instanceof Error ? error : new Error('unknown'));
    }
  }
  if (failed.length > 0) throw new Error(`audit_retention_failed:${failed.join(',')}`);
  return retired;
}
