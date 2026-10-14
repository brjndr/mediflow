import type pg from 'pg';
import type { Problem } from './convert.js';
import type { BatchStatus } from './schemas.js';

export interface BatchRow {
  id: string;
  tenant_id: string;
  kind: string;
  status: BatchStatus;
  row_count: number;
  done_count: number;
  problem_count: number;
  failure: string | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  checked_at: Date | null;
  committed_by: string | null;
  finished_at: Date | null;
}

const COLUMNS = `b.id, b.tenant_id, b.kind, b.status, b.row_count, b.done_count, b.problem_count,
  b.failure, b.created_by, coalesce(u.name, '') as created_by_name, b.created_at, b.checked_at,
  b.committed_by, b.finished_at`;

// The name is the account's, read through the staff grant on `users`.
const FROM = 'import_batches b left join users u on u.id = b.created_by';

export async function insertBatch(
  client: pg.ClientBase,
  kind: string,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into import_batches (tenant_id, kind, created_by)
     values (app_tenant_id(), $1, $2) returning id`,
    [kind, userId],
  );
  const row = rows[0];
  if (!row) throw new Error('batch was not created');
  return row.id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findBatch(client: pg.ClientBase, id: string): Promise<BatchRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<BatchRow>(`select ${COLUMNS} from ${FROM} where b.id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

/** The batch, held until the request ends, so two requests changing it take their turn. */
export async function lockBatch(client: pg.ClientBase, id: string): Promise<BatchRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{ id: string }>(
    'select id from import_batches where id = $1 for update',
    [id],
  );
  return rows[0] ? findBatch(client, id) : null;
}

interface Cursor {
  at: string;
  id: string;
}

const encodeCursor = (row: BatchRow): string =>
  Buffer.from(JSON.stringify({ at: row.created_at.toISOString(), id: row.id })).toString(
    'base64url',
  );

function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { at, id } = value as Record<string, unknown>;
    if (typeof at !== 'string' || typeof id !== 'string' || !UUID.test(id)) return null;
    if (Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** The hospital's batches, newest first. Null for a cursor that is not one of ours. */
export async function listBatches(
  client: pg.ClientBase,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: BatchRow[]; nextCursor: string | null } | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const { rows } = await client.query<BatchRow>(
    `select ${COLUMNS} from ${FROM}
     where $1::timestamptz is null or (b.created_at, b.id) < ($1::timestamptz, $2::uuid)
     order by b.created_at desc, b.id desc
     limit $3`,
    [after?.at ?? null, after?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/**
 * Adds rows to a batch. A line already there is kept as it was first sent, so a chunk sent again
 * (a retry after a lost answer) adds nothing. Returns how many rows the batch has now.
 */
export async function addRows(
  client: pg.ClientBase,
  batchId: string,
  rows: { line: number; values: Record<string, string> }[],
): Promise<number> {
  await client.query(
    `insert into import_rows (tenant_id, batch_id, line, "values")
     select app_tenant_id(), $1, r.line, r.v
     from jsonb_to_recordset($2::jsonb) as r(line integer, v jsonb)
     on conflict (tenant_id, batch_id, line) do nothing`,
    [batchId, JSON.stringify(rows.map((row) => ({ line: row.line, v: row.values })))],
  );
  const { rows: counted } = await client.query<{ count: number }>(
    'select count(*)::int as count from import_rows where batch_id = $1',
    [batchId],
  );
  const count = counted[0]?.count ?? 0;
  await client.query('update import_batches set row_count = $2 where id = $1', [batchId, count]);
  return count;
}

/**
 * Moves a batch on from a request. A batch that starts waiting for a job (checking, queued) is
 * dated by its heartbeat, so one whose job never comes is found and given up (`expireBatches`).
 */
export async function setStatus(
  client: pg.ClientBase,
  batchId: string,
  status: BatchStatus,
  extra: { committedBy?: string; failure?: string } = {},
): Promise<void> {
  await client.query(
    `update import_batches
     set status = $2,
         committed_by = coalesce($3, committed_by),
         failure = coalesce($4, failure),
         heartbeat_at = case when $2 in ('checking', 'queued') then now() else null end,
         claim_token = null,
         finished_at = case when $2 in ('committed', 'failed', 'cancelled') then now() else finished_at end
     where id = $1`,
    [batchId, status, extra.committedBy ?? null, extra.failure ?? null],
  );
}

/** Whether an error is the database refusing a second batch being written at the hospital. */
export const isAlreadyWriting = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  (error as { constraint?: unknown }).constraint === 'import_batches_one_writing';

export async function deleteRows(client: pg.ClientBase, batchId: string): Promise<void> {
  await client.query('delete from import_rows where batch_id = $1', [batchId]);
}

/** A page of rows, in the order of their lines. */
export async function readRows(
  client: pg.ClientBase,
  batchId: string,
  afterLine: number,
  limit: number,
): Promise<{ line: number; values: Record<string, string> }[]> {
  const { rows } = await client.query<{ line: number; values: Record<string, string> }>(
    `select line, "values" from import_rows
     where batch_id = $1 and line > $2 order by line limit $3`,
    [batchId, afterLine, limit],
  );
  return rows;
}

/** Replaces the report of a batch. */
export async function replaceProblems(
  client: pg.ClientBase,
  batchId: string,
  problems: (Problem & { line: number })[],
): Promise<void> {
  await client.query('delete from import_problems where batch_id = $1', [batchId]);
  for (let start = 0; start < problems.length; start += 1000) {
    const page = problems.slice(start, start + 1000);
    await client.query(
      `insert into import_problems (tenant_id, batch_id, seq, line, field, code)
       select app_tenant_id(), $1, p.seq, p.line, p.field, p.code
       from jsonb_to_recordset($2::jsonb) as p(seq integer, line integer, field text, code text)`,
      [
        batchId,
        JSON.stringify(
          page.map((problem, index) => ({
            seq: start + index + 1,
            line: problem.line,
            field: problem.field ?? null,
            code: problem.code,
          })),
        ),
      ],
    );
  }
}

export interface ProblemRow {
  seq: number;
  line: number;
  field: string | null;
  code: string;
}

/** A page of the report, in the order of the lines. */
export async function listProblems(
  client: pg.ClientBase,
  batchId: string,
  afterSeq: number,
  limit: number,
): Promise<ProblemRow[]> {
  const { rows } = await client.query<ProblemRow>(
    `select seq, line, field, code from import_problems
     where batch_id = $1 and seq > $2 order by seq limit $3`,
    [batchId, afterSeq, limit],
  );
  return rows;
}

/** The hospital's currency, which an amount in a file is in. */
export async function currencyOfHospital(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ currency: string }>(
    'select currency from tenants where id = app_tenant_id()',
  );
  const currency = rows[0]?.currency;
  if (!currency) throw new Error('the hospital has no currency');
  return currency;
}
