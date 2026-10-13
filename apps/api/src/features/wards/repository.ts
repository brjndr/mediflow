import type pg from 'pg';
import type { BedStatus, BlockReason } from './schemas.js';

/**
 * The wards, rooms, beds and bed categories SQL. Every statement runs on the request's own
 * transaction, so row-level security limits it to the active hospital: no statement here names a
 * tenant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** Whether an error is the database refusing a row because of this unique constraint. */
export const isTaken = (error: unknown, constraint: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  (error as { constraint?: unknown }).constraint === constraint;

/** Where the next page starts: after this row, in name order. A name and an id, no more. */
interface Cursor {
  n: string;
  i: string;
}

const encodeCursor = (row: { name_lower: string; id: string }): string =>
  Buffer.from(JSON.stringify({ n: row.name_lower, i: row.id } satisfies Cursor)).toString(
    'base64url',
  );

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, i } = value as Record<string, unknown>;
    if (typeof n !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
    return [...n].length <= 100 && !n.includes('\u0000') ? { n, i } : null;
  } catch {
    return null;
  }
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

// --- bed categories ----------------------------------------------------------------------------

export interface CategoryRow {
  id: string;
  tenant_id: string;
  name: string;
  name_lower: string;
  service_id: string | null;
  /** The name of the linked service. The name alone: nothing else of a service is read here. */
  service_name: string | null;
  /** Beds in use that have it: not archived, in a room that is not archived. */
  bed_count: number;
  archived: boolean;
  version: number;
}

const CATEGORIES = `
  select c.id, c.tenant_id, c.name, c.name_lower, c.service_id, s.name as service_name,
    (select count(*)::int from beds b
     join rooms r on r.tenant_id = b.tenant_id and r.id = b.room_id
     where b.tenant_id = c.tenant_id and b.bed_category_id = c.id
       and not b.archived and not r.archived) as bed_count,
    c.archived, c.version
  from bed_categories c
  left join services s on s.tenant_id = c.tenant_id and s.id = c.service_id`;

/** One page of the hospital's active (or archived) bed categories, by name. Null: bad cursor. */
export async function listCategories(
  client: pg.ClientBase,
  { archived, cursor, limit }: { archived: boolean; cursor?: string; limit: number },
): Promise<Page<CategoryRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const { rows } = await client.query<CategoryRow>(
    `${CATEGORIES}
     where c.archived = $1 and ($2::text is null or (c.name_lower, c.id) > ($2, $3::uuid))
     order by c.name_lower, c.id
     limit $4`,
    [archived, after?.n ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: Page<CategoryRow> = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      'select count(*)::int as total from bed_categories where archived = $1',
      [archived],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findCategory(client: pg.ClientBase, id: string): Promise<CategoryRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<CategoryRow>(`${CATEGORIES} where c.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The category, held until the transaction ends, or null when this hospital has none such.
 * `for update` to change it; `for share` to give it to a bed, so that it is not archived at the
 * same moment.
 */
export async function lockCategory(
  client: pg.ClientBase,
  id: string,
  strength: 'update' | 'share' = 'update',
): Promise<CategoryRow | null> {
  if (!UUID.test(id)) return null;
  const locked = await client.query(
    `select 1 from bed_categories where id = $1 for ${strength === 'update' ? 'update' : 'share'}`,
    [id],
  );
  return locked.rowCount === 1 ? findCategory(client, id) : null;
}

/** Whether the hospital already has a category of this name, archived or not. */
export async function categoryNameTaken(
  client: pg.ClientBase,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from bed_categories where name_lower = lower($1) and ($2::uuid is null or id <> $2)',
    [name, exceptId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** A bed-day service of the hospital: whether it is one, and whether it is archived. */
export async function bedService(
  client: pg.ClientBase,
  id: string,
): Promise<{ archived: boolean } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{ archived: boolean }>(
    "select archived from services where id = $1 and category = 'bed'",
    [id],
  );
  return rows[0] ?? null;
}

export async function insertCategory(
  client: pg.ClientBase,
  input: { name: string; serviceId: string | null },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into bed_categories (tenant_id, name, service_id)
     values (app_tenant_id(), $1, $2) returning id`,
    [input.name, input.serviceId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('bed category was not created');
  return id;
}

export async function updateCategory(
  client: pg.ClientBase,
  id: string,
  input: { name: string; serviceId: string | null },
): Promise<void> {
  const { rowCount } = await client.query(
    'update bed_categories set name = $2, service_id = $3 where id = $1',
    [id, input.name, input.serviceId],
  );
  if (rowCount !== 1) throw new Error('bed category was not updated');
}

/** Whether a bed that is not archived has this category. */
export async function categoryInUse(client: pg.ClientBase, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from beds where bed_category_id = $1 and not archived limit 1',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

// --- wards -------------------------------------------------------------------------------------

export interface WardRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  name_lower: string;
  floor: string | null;
  department_id: string | null;
  department_name: string | null;
  room_count: number;
  bed_count: number;
  archived: boolean;
  version: number;
}

const WARDS = `
  select w.id, w.tenant_id, w.code, w.name, w.name_lower, w.floor, w.department_id,
    d.name as department_name,
    (select count(*)::int from rooms r
     where r.tenant_id = w.tenant_id and r.ward_id = w.id and not r.archived) as room_count,
    (select count(*)::int from beds b
     join rooms r on r.tenant_id = b.tenant_id and r.id = b.room_id
     where b.tenant_id = w.tenant_id and b.ward_id = w.id
       and not b.archived and not r.archived) as bed_count,
    w.archived, w.version
  from wards w
  left join departments d on d.tenant_id = w.tenant_id and d.id = w.department_id`;

/**
 * One page of the hospital's active (or archived) wards, by name. Every word of the term must be
 * in the code or the name. Null for a bad cursor.
 */
export async function listWards(
  client: pg.ClientBase,
  { q, archived, cursor, limit }: { q?: string; archived: boolean; cursor?: string; limit: number },
): Promise<Page<WardRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const params: unknown[] = [archived];
  const where = ['w.archived = $1'];
  for (const word of (q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(likePattern(word));
    where.push(`w.search_text like lower($${params.length})`);
  }
  const filters = params.length;
  params.push(after?.n ?? null, after?.i ?? null, limit + 1);
  const [n, i, max] = [filters + 1, filters + 2, filters + 3];
  const { rows } = await client.query<WardRow>(
    `${WARDS}
     where ${where.join(' and ')}
       and ($${n}::text is null or (w.name_lower, w.id) > ($${n}, $${i}::uuid))
     order by w.name_lower, w.id
     limit $${max}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: Page<WardRow> = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from wards w where ${where.join(' and ')}`,
      params.slice(0, filters),
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findWard(client: pg.ClientBase, id: string): Promise<WardRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<WardRow>(`${WARDS} where w.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The ward, locked until the transaction ends, or null when this hospital has none such. Every
 * change of a ward, of its rooms and of its beds starts here, so changes within a ward take
 * their turn.
 */
export async function lockWard(client: pg.ClientBase, id: string): Promise<WardRow | null> {
  if (!UUID.test(id)) return null;
  const locked = await client.query('select 1 from wards where id = $1 for update', [id]);
  return locked.rowCount === 1 ? findWard(client, id) : null;
}

/** Whether the hospital already has a ward of this code, archived or not. */
export async function wardCodeTaken(client: pg.ClientBase, code: string): Promise<boolean> {
  const { rowCount } = await client.query('select 1 from wards where code_lower = lower($1)', [
    code,
  ]);
  return (rowCount ?? 0) > 0;
}

/** A department of the hospital: whether it is one, and whether it is archived. */
export async function department(
  client: pg.ClientBase,
  id: string,
): Promise<{ archived: boolean } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{ archived: boolean }>(
    'select archived from departments where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export interface WardDetails {
  name: string;
  floor: string | null;
  departmentId: string | null;
}

export async function insertWard(
  client: pg.ClientBase,
  input: WardDetails & { code: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into wards (tenant_id, code, name, floor, department_id)
     values (app_tenant_id(), $1, $2, $3, $4) returning id`,
    [input.code, input.name, input.floor, input.departmentId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('ward was not created');
  return id;
}

export async function updateWard(
  client: pg.ClientBase,
  id: string,
  input: WardDetails,
): Promise<void> {
  const { rowCount } = await client.query(
    'update wards set name = $2, floor = $3, department_id = $4 where id = $1',
    [id, input.name, input.floor, input.departmentId],
  );
  if (rowCount !== 1) throw new Error('ward was not updated');
}

/** Whether a bed of the ward that is not archived is occupied. */
export async function wardHasOccupiedBed(client: pg.ClientBase, wardId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "select 1 from beds where ward_id = $1 and status = 'occupied' and not archived limit 1",
    [wardId],
  );
  return (rowCount ?? 0) > 0;
}

/** Archives or restores a row of a table. False when it is already as asked: nothing is written. */
export async function setArchived(
  client: pg.ClientBase,
  table: 'bed_categories' | 'wards' | 'rooms' | 'beds',
  id: string,
  archived: boolean,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update ${table} set archived = $2 where id = $1 and archived <> $2`,
    [id, archived],
  );
  return rowCount === 1;
}

// --- rooms and beds ----------------------------------------------------------------------------

export interface RoomRow {
  id: string;
  name: string;
  archived: boolean;
  version: number;
}

export interface BedRow {
  id: string;
  room_id: string;
  number: string;
  bed_category_id: string;
  bed_category_name: string;
  status: BedStatus;
  blocked_reason: BlockReason | null;
  blocked_note: string | null;
  archived: boolean;
  version: number;
}

const BEDS = `
  select b.id, b.room_id, b.number, b.bed_category_id, c.name as bed_category_name, b.status,
    b.blocked_reason, b.blocked_note, b.archived, b.version
  from beds b
  join bed_categories c on c.tenant_id = b.tenant_id and c.id = b.bed_category_id`;

/** The rooms of a ward and all its beds, archived ones included. A ward has a bounded number. */
export async function roomsAndBeds(
  client: pg.ClientBase,
  wardId: string,
): Promise<{ rooms: RoomRow[]; beds: BedRow[] }> {
  const rooms = await client.query<RoomRow>(
    'select id, name, archived, version from rooms where ward_id = $1',
    [wardId],
  );
  const beds = await client.query<BedRow>(`${BEDS} where b.ward_id = $1`, [wardId]);
  return { rooms: rooms.rows, beds: beds.rows };
}

/** A room of this ward, or null. The ward is locked by the caller. */
export async function findRoom(
  client: pg.ClientBase,
  wardId: string,
  roomId: string,
): Promise<RoomRow | null> {
  if (!UUID.test(roomId)) return null;
  const { rows } = await client.query<RoomRow>(
    'select id, name, archived, version from rooms where id = $1 and ward_id = $2',
    [roomId, wardId],
  );
  return rows[0] ?? null;
}

/** Whether another room of the ward has this name, archived or not. */
export async function roomNameTaken(
  client: pg.ClientBase,
  wardId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from rooms
     where ward_id = $1 and name_lower = lower($2) and ($3::uuid is null or id <> $3)`,
    [wardId, name, exceptId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertRoom(
  client: pg.ClientBase,
  wardId: string,
  name: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'insert into rooms (tenant_id, ward_id, name) values (app_tenant_id(), $1, $2) returning id',
    [wardId, name],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('room was not created');
  return id;
}

export async function renameRoom(
  client: pg.ClientBase,
  roomId: string,
  name: string,
): Promise<void> {
  const { rowCount } = await client.query('update rooms set name = $2 where id = $1', [
    roomId,
    name,
  ]);
  if (rowCount !== 1) throw new Error('room was not renamed');
}

/** Whether a bed of the room that is not archived is occupied. */
export async function roomHasOccupiedBed(client: pg.ClientBase, roomId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "select 1 from beds where room_id = $1 and status = 'occupied' and not archived limit 1",
    [roomId],
  );
  return (rowCount ?? 0) > 0;
}

/** Archives the beds of a room that are not archived yet, each keeping its status. Their ids. */
export async function archiveBedsOfRoom(client: pg.ClientBase, roomId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    'update beds set archived = true where room_id = $1 and not archived returning id',
    [roomId],
  );
  return rows.map((row) => row.id);
}

/** A bed of this ward, or null. The ward is locked by the caller. */
export async function findBed(
  client: pg.ClientBase,
  wardId: string,
  bedId: string,
): Promise<BedRow | null> {
  if (!UUID.test(bedId)) return null;
  const { rows } = await client.query<BedRow>(`${BEDS} where b.id = $1 and b.ward_id = $2`, [
    bedId,
    wardId,
  ]);
  return rows[0] ?? null;
}

/** Whether another bed of the ward has this number, archived or not. */
export async function bedNumberTaken(
  client: pg.ClientBase,
  wardId: string,
  number: string,
  exceptId?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from beds
     where ward_id = $1 and number_lower = lower($2) and ($3::uuid is null or id <> $3)`,
    [wardId, number, exceptId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertBed(
  client: pg.ClientBase,
  input: { wardId: string; roomId: string; number: string; categoryId: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into beds (tenant_id, ward_id, room_id, number, bed_category_id)
     values (app_tenant_id(), $1, $2, $3, $4) returning id`,
    [input.wardId, input.roomId, input.number, input.categoryId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('bed was not created');
  return id;
}

export async function updateBed(
  client: pg.ClientBase,
  bedId: string,
  input: { number: string; categoryId: string },
): Promise<void> {
  const { rowCount } = await client.query(
    'update beds set number = $2, bed_category_id = $3 where id = $1',
    [bedId, input.number, input.categoryId],
  );
  if (rowCount !== 1) throw new Error('bed was not updated');
}

/**
 * Moves a bed from one status to another, on the row as it is: false when it is not in the
 * status the change starts from, so of two people making it only one does.
 */
export async function moveBed(
  client: pg.ClientBase,
  bedId: string,
  from: BedStatus,
  to: BedStatus,
  blocked: { reason: BlockReason; note: string | null } | null,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update beds set status = $3, blocked_reason = $4, blocked_note = $5
     where id = $1 and status = $2 and not archived`,
    [bedId, from, to, blocked?.reason ?? null, blocked?.note ?? null],
  );
  return rowCount === 1;
}
