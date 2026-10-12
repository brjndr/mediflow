import type pg from 'pg';

/**
 * The departments SQL. Every statement runs on the request's own transaction, so row-level
 * security limits it to the active hospital: no statement here names a tenant.
 */

export interface DepartmentRow {
  id: string;
  tenant_id: string;
  name: string;
  name_lower: string;
  description: string | null;
  archived: boolean;
  version: number;
}

const COLUMNS = 'id, tenant_id, name, name_lower, description, archived, version';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the next page starts: after this row, in name order. Holds a name and an id, no more. */
interface Cursor {
  n: string;
  i: string;
}

const encodeCursor = (row: DepartmentRow): string =>
  Buffer.from(JSON.stringify({ n: row.name_lower, i: row.id } satisfies Cursor)).toString(
    'base64url',
  );

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, i } = value as Record<string, unknown>;
    return typeof n === 'string' && typeof i === 'string' && UUID.test(i) ? { n, i } : null;
  } catch {
    return null;
  }
}

export interface DepartmentList {
  rows: DepartmentRow[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/** One page of the hospital's active (or archived) departments, by name. Null for a bad cursor. */
export async function listDepartments(
  client: pg.ClientBase,
  { archived, cursor, limit }: { archived: boolean; cursor?: string; limit: number },
): Promise<DepartmentList | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const { rows } = await client.query<DepartmentRow>(
    `select ${COLUMNS} from departments
     where archived = $1 and ($2::text is null or (name_lower, id) > ($2, $3::uuid))
     order by name_lower, id
     limit $4`,
    [archived, after?.n ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: DepartmentList = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      'select count(*)::int as total from departments where archived = $1',
      [archived],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** The department, locked until the transaction ends, or null when this hospital has none such. */
export async function lockDepartment(
  client: pg.ClientBase,
  id: string,
): Promise<DepartmentRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<DepartmentRow>(
    `select ${COLUMNS} from departments where id = $1 for update`,
    [id],
  );
  return rows[0] ?? null;
}

/** Whether the hospital already has a department of this name, archived or not. */
export async function nameTaken(
  client: pg.ClientBase,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from departments where name_lower = lower($1) and ($2::uuid is null or id <> $2)',
    [name, exceptId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Whether an error is the database refusing a second department of the same name. */
export const isNameTaken = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  (error as { constraint?: unknown }).constraint === 'departments_name_taken';

export async function insertDepartment(
  client: pg.ClientBase,
  input: { name: string; description: string | null },
): Promise<DepartmentRow> {
  const { rows } = await client.query<DepartmentRow>(
    `insert into departments (tenant_id, name, description)
     values (app_tenant_id(), $1, $2)
     returning ${COLUMNS}`,
    [input.name, input.description],
  );
  const row = rows[0];
  if (!row) throw new Error('department was not created');
  return row;
}

export async function updateDepartment(
  client: pg.ClientBase,
  id: string,
  changes: { name: string; description: string | null },
): Promise<DepartmentRow> {
  const { rows } = await client.query<DepartmentRow>(
    `update departments set name = $2, description = $3 where id = $1 returning ${COLUMNS}`,
    [id, changes.name, changes.description],
  );
  const row = rows[0];
  if (!row) throw new Error('department was not updated');
  return row;
}

/** Archives or restores. Null when the department is already as asked: nothing is written. */
export async function setArchived(
  client: pg.ClientBase,
  id: string,
  archived: boolean,
): Promise<DepartmentRow | null> {
  const { rows } = await client.query<DepartmentRow>(
    `update departments set archived = $2 where id = $1 and archived <> $2 returning ${COLUMNS}`,
    [id, archived],
  );
  return rows[0] ?? null;
}
