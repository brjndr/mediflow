import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';

/**
 * Keyset paging for the operations lists: ordered by one timestamp column and the row's id, so a
 * cursor keeps its place however the list changes. The caller's SQL names the main table `x`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00$/;
export const isUuid = (value: string): boolean => UUID.test(value);

export interface Paged<Row> {
  rows: Row[];
  nextCursor: string | null;
}

interface Cursor {
  t: string;
  i: string;
}

function decode(cursor: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof value.t === 'string' &&
      typeof value.i === 'string' &&
      PG_TIMESTAMP.test(value.t) &&
      UUID.test(value.i)
    ) {
      return { t: value.t, i: value.i };
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
}

export interface PageSpec {
  /** `select x.a, x.b from table x join ...` without a where. */
  select: string;
  /** Conditions joined with and; their `$n` refer to `params`. */
  where: string[];
  params: unknown[];
  /** The timestamp column to order by, as `x.starts_at`. */
  order: string;
  desc?: boolean;
  cursor?: string | undefined;
  limit: number;
}

export async function selectPage<Row extends { id: string }>(
  client: pg.ClientBase,
  spec: PageSpec,
): Promise<Paged<Row>> {
  const params = [...spec.params];
  const where = [...spec.where];
  if (spec.cursor) {
    const cursor = decode(spec.cursor);
    params.push(cursor.t, cursor.i);
    where.push(
      `(${spec.order}, x.id) ${spec.desc ? '<' : '>'} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(spec.limit + 1);
  const dir = spec.desc ? 'desc' : 'asc';
  const head = spec.select.replace(
    /\sfrom\s/i,
    `, to_char(${spec.order} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as order_at from `,
  );
  const { rows } = await client.query<Row & { order_at: string }>(
    `${head} ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
     order by ${spec.order} ${dir}, x.id ${dir} limit $${params.length}`,
    params,
  );
  const more = rows.length > spec.limit;
  const page = more ? rows.slice(0, spec.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      more && last
        ? Buffer.from(JSON.stringify({ t: last.order_at, i: last.id })).toString('base64url')
        : null,
  };
}
