import type pg from 'pg';
import type { ReportKind } from './schemas.js';
import type { ReportResult } from './schemas.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a hospital has when no `report_settings` row says otherwise. */
export const DEFAULT_LIMITS = { maxConcurrent: 2, maxPerDay: 50, retentionDays: 30 } as const;

export interface RunRow {
  id: string;
  kind: ReportKind;
  range_from: string | null;
  range_to: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  requested_by: string;
  requested_by_name: string;
  requested_at: Date;
  finished_at: Date | null;
  expires_at: Date;
  row_count: number | null;
  failure: string | null;
  file_key: string | null;
}

// The name is the account's, read through the staff grant on `users`.
const COLUMNS = `r.id, r.kind, r.range_from::text as range_from, r.range_to::text as range_to,
  r.status, r.requested_by, coalesce(u.name, '') as requested_by_name, r.requested_at,
  r.finished_at, r.expires_at, r.row_count, r.failure, r.file_key`;
const FROM = 'report_runs r left join users u on u.id = r.requested_by';

export interface Limits {
  maxConcurrent: number;
  maxPerDay: number;
  retentionDays: number;
  active: number;
  usedToday: number;
}

/** The hospital's limits (the defaults when it has none set) and what it has used. */
export async function limitsOf(client: pg.ClientBase): Promise<Limits> {
  const { rows } = await client.query<{
    max_concurrent: number;
    max_per_day: number;
    retention_days: number;
    active: number;
    used_today: number;
  }>(
    `select coalesce(s.max_concurrent, $1)::int as max_concurrent,
            coalesce(s.max_per_day, $2)::int as max_per_day,
            coalesce(s.retention_days, $3)::int as retention_days,
            (select count(*) from report_runs
             where status in ('queued', 'running')
               and requested_at > now() - interval '1 hour')::int as active,
            (select count(*) from report_runs
             where requested_at > now() - interval '24 hours')::int as used_today
     from (select 1) one
     left join report_settings s on s.tenant_id = app_tenant_id()`,
    [DEFAULT_LIMITS.maxConcurrent, DEFAULT_LIMITS.maxPerDay, DEFAULT_LIMITS.retentionDays],
  );
  const row = rows[0];
  if (!row) throw new Error('limits were not read');
  return {
    maxConcurrent: row.max_concurrent,
    maxPerDay: row.max_per_day,
    retentionDays: row.retention_days,
    active: row.active,
    usedToday: row.used_today,
  };
}

/**
 * Takes the hospital's quota lock for the rest of the transaction, so two requests asking at the
 * same moment cannot both see room for one more.
 */
export async function lockQuota(client: pg.ClientBase): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('report_runs:' || app_tenant_id()::text, 0))",
  );
}

export async function insertRun(
  client: pg.ClientBase,
  run: { kind: ReportKind; from: string | null; to: string | null; userId: string },
  retentionDays: number,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into report_runs (tenant_id, kind, range_from, range_to, requested_by, expires_at)
     values (app_tenant_id(), $1, $2::date, $3::date, $4, now() + make_interval(days => $5))
     returning id`,
    [run.kind, run.from, run.to, run.userId, retentionDays],
  );
  const row = rows[0];
  if (!row) throw new Error('run was not created');
  return row.id;
}

export async function findRun(client: pg.ClientBase, id: string): Promise<RunRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<RunRow>(`select ${COLUMNS} from ${FROM} where r.id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

/** The stored result of a run that has succeeded. */
export async function resultOf(client: pg.ClientBase, id: string): Promise<ReportResult | null> {
  const { rows } = await client.query<{ result: ReportResult | null }>(
    'select result from report_runs where id = $1',
    [id],
  );
  return rows[0]?.result ?? null;
}

interface Cursor {
  at: string;
  id: string;
}

const encodeCursor = (row: RunRow): string =>
  Buffer.from(JSON.stringify({ at: row.requested_at.toISOString(), id: row.id })).toString(
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

/** The hospital's stored reports, newest first. Null for a cursor that is not one of ours. */
export async function listRuns(
  client: pg.ClientBase,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: RunRow[]; nextCursor: string | null } | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const { rows } = await client.query<RunRow>(
    `select ${COLUMNS} from ${FROM}
     where $1::timestamptz is null or (r.requested_at, r.id) < ($1::timestamptz, $2::uuid)
     order by r.requested_at desc, r.id desc
     limit $3`,
    [after?.at ?? null, after?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
