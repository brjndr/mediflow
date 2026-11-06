import type pg from 'pg';
import type { PrescriptionSetLine } from './schemas.js';

/**
 * The prescription sets SQL. Every statement runs on the request's own transaction, so row-level
 * security limits it to the active hospital. A caller sees the hospital's shared sets and their
 * own: `userId` narrows every read to that.
 */

export interface SetRow {
  id: string;
  tenant_id: string;
  name: string;
  name_lower: string;
  owner_user_id: string | null;
  archived: boolean;
  version: number;
  updated_at: Date;
  line_count: number;
}

export interface LineRow {
  drug_id: string;
  dose: string;
  route: PrescriptionSetLine['route'];
  frequency: string;
  duration_days: number | null;
  quantity: number | null;
  instructions: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `s.id, s.tenant_id, s.name, s.name_lower, s.owner_user_id, s.archived, s.version,
  s.updated_at,
  (select count(*)::int from prescription_set_lines l
     where l.tenant_id = s.tenant_id and l.set_id = s.id) as line_count`;
const VISIBLE = '(s.owner_user_id is null or s.owner_user_id = $1)';

interface Cursor {
  n: string;
  i: string;
}

const encodeCursor = (row: SetRow): string =>
  Buffer.from(JSON.stringify({ n: row.name_lower, i: row.id } satisfies Cursor)).toString(
    'base64url',
  );

function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, i } = value as Record<string, unknown>;
    if (typeof n !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
    return n.length <= 200 && !n.includes('\u0000') ? { n, i } : null;
  } catch {
    return null;
  }
}

export interface SetList {
  rows: SetRow[];
  nextCursor: string | null;
  total?: number;
}

/** One page of the sets the caller may see, by name. Null for a bad cursor. */
export async function listSets(
  client: pg.ClientBase,
  userId: string,
  { archived, cursor, limit }: { archived: boolean; cursor?: string; limit: number },
): Promise<SetList | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const { rows } = await client.query<SetRow>(
    `select ${COLUMNS} from prescription_sets s
     where ${VISIBLE} and s.archived = $2
       and ($3::text is null or (s.name_lower, s.id) > ($3, $4::uuid))
     order by s.name_lower, s.id
     limit $5`,
    [userId, archived, after?.n ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: SetList = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from prescription_sets s where ${VISIBLE} and s.archived = $2`,
      [userId, archived],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** The set when the caller may see it; null for a missing one, another hospital's and another doctor's. */
export async function findSet(
  client: pg.ClientBase,
  userId: string,
  id: string,
  { lock = false }: { lock?: boolean } = {},
): Promise<SetRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<SetRow>(
    `select ${COLUMNS} from prescription_sets s where ${VISIBLE} and s.id = $2${lock ? ' for update of s' : ''}`,
    [userId, id],
  );
  return rows[0] ?? null;
}

export async function linesOf(client: pg.ClientBase, setId: string): Promise<LineRow[]> {
  const { rows } = await client.query<LineRow>(
    `select drug_id, dose, route, frequency, duration_days, quantity, instructions
     from prescription_set_lines where set_id = $1 order by line_number`,
    [setId],
  );
  return rows;
}

export async function insertSet(
  client: pg.ClientBase,
  { name, ownerId }: { name: string; ownerId: string | null },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into prescription_sets (tenant_id, name, owner_user_id)
     values (app_tenant_id(), $1, $2) returning id`,
    [name, ownerId],
  );
  return rows[0]!.id;
}

/** Replaces the lines of a set, numbered from 1 in the order given. */
export async function replaceLines(
  client: pg.ClientBase,
  setId: string,
  lines: readonly PrescriptionSetLine[],
): Promise<void> {
  await client.query('delete from prescription_set_lines where set_id = $1', [setId]);
  let number = 0;
  for (const line of lines) {
    number += 1;
    await client.query(
      `insert into prescription_set_lines
         (tenant_id, set_id, line_number, drug_id, dose, route, frequency, duration_days, quantity, instructions)
       values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        setId,
        number,
        line.drugId,
        line.dose,
        line.route,
        line.frequency,
        line.durationDays ?? null,
        line.quantity ?? null,
        line.instructions ?? null,
      ],
    );
  }
}

/** Changes the fields given and moves the version on. */
export async function updateSet(
  client: pg.ClientBase,
  id: string,
  { name, archived }: { name?: string; archived?: boolean },
): Promise<void> {
  await client.query(
    `update prescription_sets
     set name = coalesce($2, name), archived = coalesce($3, archived),
         version = version + 1, updated_at = now()
     where id = $1`,
    [id, name ?? null, archived ?? null],
  );
}

/** Whether the caller's own (or the shared) sets already have this name, other than `exceptId`. */
export async function nameTaken(
  client: pg.ClientBase,
  { name, ownerId, exceptId }: { name: string; ownerId: string | null; exceptId?: string },
): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 from prescription_sets
     where name_lower = lower($1) and owner_user_id is not distinct from $2::uuid
       and ($3::uuid is null or id <> $3)`,
    [name, ownerId, exceptId ?? null],
  );
  return rows.length > 0;
}

export const isNameTaken = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: string }).code === '23505' &&
  /^prescription_sets_(shared|own)_name$/.test((error as { constraint?: string }).constraint ?? '');

export async function favouriteIds(client: pg.ClientBase, userId: string): Promise<string[]> {
  const { rows } = await client.query<{ drug_id: string }>(
    'select drug_id from doctor_favourite_drugs where user_id = $1 order by position',
    [userId],
  );
  return rows.map((row) => row.drug_id);
}

export async function replaceFavourites(
  client: pg.ClientBase,
  userId: string,
  drugIds: readonly string[],
): Promise<void> {
  await client.query('delete from doctor_favourite_drugs where user_id = $1', [userId]);
  let position = 0;
  for (const drugId of drugIds) {
    position += 1;
    await client.query(
      `insert into doctor_favourite_drugs (tenant_id, user_id, drug_id, position)
       values (app_tenant_id(), $1, $2, $3)`,
      [userId, drugId, position],
    );
  }
}
