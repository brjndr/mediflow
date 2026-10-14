import type pg from 'pg';
import type { DrugForm, DrugSchedule, DrugType, TaxClass } from './schemas.js';

/**
 * The drugs and consumables SQL. Every statement runs on the request's own transaction, so
 * row-level security limits it to the active hospital: no statement here names a tenant.
 */

export interface DrugRow {
  id: string;
  tenant_id: string;
  type: DrugType;
  generic_name: string;
  brand_name: string | null;
  form: DrugForm;
  strength: string | null;
  unit: string | null;
  schedule: DrugSchedule;
  controlled: boolean;
  tax_class: TaxClass;
  reorder_level: number | null;
  archived: boolean;
  version: number;
  generic_lower: string;
  brand_lower: string;
}

/**
 * A text as the key columns of migration 0031 hold it, for a parameter: lower case, and without
 * the joiners Indic scripts need, which many places print as nothing.
 */
const key = (param: string) => `lower(translate(${param}, chr(8204) || chr(8205), ''))`;

/** What a request can set on an item. */
export interface DrugDetails {
  type: DrugType;
  genericName: string;
  brandName: string | null;
  form: DrugForm;
  strength: string | null;
  unit: string | null;
  schedule: DrugSchedule;
  controlled: boolean;
  taxClass: TaxClass;
  reorderLevel: number | null;
}

const COLUMNS = `id, tenant_id, type, generic_name, brand_name, form, strength, unit, schedule,
  controlled, tax_class, reorder_level, archived, version, generic_lower, brand_lower`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the next page starts: after this row, by generic name then brand. No more than that. */
interface Cursor {
  g: string;
  b: string;
  i: string;
}

const encodeCursor = (row: DrugRow): string =>
  Buffer.from(
    JSON.stringify({ g: row.generic_lower, b: row.brand_lower, i: row.id } satisfies Cursor),
  ).toString('base64url');

/** Text this module stored as a name: never longer than one, never a character Postgres refuses. */
const isStoredName = (value: unknown): value is string =>
  typeof value === 'string' && [...value].length <= 150 && !value.includes('\u0000');

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { g, b, i } = value as Record<string, unknown>;
    if (!isStoredName(g) || !isStoredName(b) || typeof i !== 'string' || !UUID.test(i)) return null;
    return { g, b, i };
  } catch {
    return null;
  }
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export interface DrugSearch {
  q?: string;
  type?: DrugType;
  form?: DrugForm;
  schedule?: DrugSchedule;
  /** True lists only controlled drugs. */
  controlled: boolean;
  archived: boolean;
  cursor?: string;
  limit: number;
}

export interface DrugList {
  rows: DrugRow[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/**
 * One page of the hospital's active (or archived) items, by generic name then brand. Every word
 * of the term must be in the generic name or the brand. The rows are found through the tenant
 * index and the text matched against those: a text index is never used under row-level
 * security. Null for a bad cursor.
 */
export async function searchDrugs(
  client: pg.ClientBase,
  { q, type, form, schedule, controlled, archived, cursor, limit }: DrugSearch,
): Promise<DrugList | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;

  const params: unknown[] = [archived];
  const where = ['archived = $1'];
  const only = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  };
  only('type', type);
  only('form', form);
  only('schedule', schedule);
  if (controlled) where.push('controlled');
  for (const word of (q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(likePattern(word));
    // The database lower-cases both sides: its idea of lower case is not JavaScript's.
    where.push(`search_text like lower($${params.length})`);
  }
  const filters = params.length;

  params.push(after?.g ?? null, after?.b ?? null, after?.i ?? null, limit + 1);
  const [g, b, i, max] = [filters + 1, filters + 2, filters + 3, filters + 4];
  const { rows } = await client.query<DrugRow>(
    `select ${COLUMNS} from drugs
     where ${where.join(' and ')}
       and ($${g}::text is null
         or (generic_lower, brand_lower, id) > ($${g}, $${b}::text, $${i}::uuid))
     order by generic_lower, brand_lower, id
     limit $${max}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: DrugList = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from drugs where ${where.join(' and ')}`,
      params.slice(0, filters),
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** The item, or null when this hospital has none such. */
export async function findDrug(client: pg.ClientBase, id: string): Promise<DrugRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<DrugRow>(`select ${COLUMNS} from drugs where id = $1`, [id]);
  return rows[0] ?? null;
}

/** The item, locked until the transaction ends, or null when this hospital has none such. */
export async function lockDrug(client: pg.ClientBase, id: string): Promise<DrugRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<DrugRow>(
    `select ${COLUMNS} from drugs where id = $1 for update`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Items of the hospital, archived or not, with this generic name in this form, whatever the brand
 * or the strength, the capitals or the Indic joiners. The database decides what the same name is.
 */
export async function similarDrugs(
  client: pg.ClientBase,
  genericName: string,
  form: DrugForm,
  limit: number,
): Promise<DrugRow[]> {
  const { rows } = await client.query<DrugRow>(
    `select ${COLUMNS} from drugs
     where generic_key = ${key('$1')} and form = $2
     order by generic_lower, brand_lower, id
     limit $3`,
    [genericName, form, limit],
  );
  return rows;
}

/**
 * Whether the hospital has a controlled item of this generic name in this form, archived or not,
 * other than the one named, whatever the capitals or the Indic joiners.
 */
export async function hasControlledSibling(
  client: pg.ClientBase,
  genericName: string,
  form: DrugForm,
  exceptId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from drugs
     where generic_key = ${key('$1')} and form = $2 and controlled and id <> $3
     limit 1`,
    [genericName, form, exceptId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Whether the hospital already has exactly this item: generic name, brand, form and strength,
 * whatever the capitals or the Indic joiners, archived or not.
 */
export async function drugExists(
  client: pg.ClientBase,
  details: Pick<DrugDetails, 'genericName' | 'brandName' | 'form' | 'strength'>,
  exceptId?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from drugs
     where generic_key = ${key('$1')} and brand_key = ${key("coalesce($2, '')")}
       and form = $3 and strength_key = ${key("coalesce($4, '')")}
       and ($5::uuid is null or id <> $5)`,
    [details.genericName, details.brandName, details.form, details.strength, exceptId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Whether an error is the database refusing a second item that is exactly the same. */
export const isDrugExists = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  ['drugs_exists', 'drugs_same'].includes(String((error as { constraint?: unknown }).constraint));

const values = (details: DrugDetails): unknown[] => [
  details.type,
  details.genericName,
  details.brandName,
  details.form,
  details.strength,
  details.unit,
  details.schedule,
  details.controlled,
  details.taxClass,
  details.reorderLevel,
];

export async function insertDrug(client: pg.ClientBase, details: DrugDetails): Promise<DrugRow> {
  const { rows } = await client.query<DrugRow>(
    `insert into drugs (tenant_id, type, generic_name, brand_name, form, strength, unit, schedule,
       controlled, tax_class, reorder_level)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${COLUMNS}`,
    values(details),
  );
  const row = rows[0];
  if (!row) throw new Error('item was not created');
  return row;
}

export async function updateDrug(
  client: pg.ClientBase,
  id: string,
  details: DrugDetails,
): Promise<DrugRow> {
  const { rows } = await client.query<DrugRow>(
    `update drugs set type = $2, generic_name = $3, brand_name = $4, form = $5, strength = $6,
       unit = $7, schedule = $8, controlled = $9, tax_class = $10, reorder_level = $11
     where id = $1
     returning ${COLUMNS}`,
    [id, ...values(details)],
  );
  const row = rows[0];
  if (!row) throw new Error('item was not updated');
  return row;
}

/** Archives or restores. Null when the item is already as asked: nothing is written. */
export async function setArchived(
  client: pg.ClientBase,
  id: string,
  archived: boolean,
): Promise<DrugRow | null> {
  const { rows } = await client.query<DrugRow>(
    `update drugs set archived = $2 where id = $1 and archived <> $2 returning ${COLUMNS}`,
    [id, archived],
  );
  return rows[0] ?? null;
}
