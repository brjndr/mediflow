import type pg from 'pg';
import type { Modality, ServiceCategory, TaxClass } from './schemas.js';

/**
 * The services and prices SQL. Every statement runs on the request's own transaction, so
 * row-level security limits it to the active hospital: no statement here names a tenant.
 */

export interface PriceRow {
  id: string;
  service_id: string;
  price_list_id: string;
  amount_minor: number;
  effective_from: string;
  effective_to: string | null;
}

/** A service as stored, with nothing of its prices. */
export interface StoredService {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  name_lower: string;
  category: ServiceCategory;
  tax_class: TaxClass;
  modality: Modality | null;
  description: string | null;
  archived: boolean;
  version: number;
}

/** A service with the price in force today on the hospital's standard list, when it has one. */
export interface ServiceRow extends StoredService {
  price_id: string | null;
  price_list_id: string | null;
  amount_minor: number | null;
  effective_from: string | null;
  effective_to: string | null;
}

const STORED =
  'id, tenant_id, code, name, name_lower, category, tax_class, modality, description, archived, version';

// An amount is at most 10^12, well inside what a JavaScript number holds exactly.
const PRICE_COLUMNS = `id, service_id, price_list_id, amount_minor::float8 as amount_minor,
  effective_from::text as effective_from, effective_to::text as effective_to`;

/**
 * Services joined to the price in force on the date in parameter `$<today>`. The exclusion
 * constraint leaves at most one such price for a service and a list.
 */
const servicesWithPrice = (today: number) => `
  select s.id, s.tenant_id, s.code, s.name, s.name_lower, s.category, s.tax_class,
    s.modality, s.description, s.archived, s.version,
    p.id as price_id, p.price_list_id, p.amount_minor::float8 as amount_minor,
    p.effective_from::text as effective_from, p.effective_to::text as effective_to
  from services s
  left join lateral (
    select sp.id, sp.price_list_id, sp.amount_minor, sp.effective_from, sp.effective_to
    from service_prices sp
    join price_lists pl
      on pl.tenant_id = sp.tenant_id and pl.id = sp.price_list_id and pl.standard
    where sp.tenant_id = s.tenant_id and sp.service_id = s.id and sp.withdrawn_at is null
      and sp.effective_from <= $${today}::date
      and (sp.effective_to is null or sp.effective_to >= $${today}::date)
    limit 1
  ) p on true`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date that is on the calendar, and that the database takes: 2026-02-30 has the right shape and
 * is not one, and Postgres has no year 0.
 */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value) || value < '0001-01-01') return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function decode(cursor: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Where the next page of services starts: after this row, in name order. A name and an id. */
function decodeServiceCursor(cursor: string): { n: string; i: string } | null {
  const { n, i } = decode(cursor) ?? {};
  if (typeof n !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
  // A name this module stored: never longer than a name (in characters, as the database
  // counts them), never a character Postgres refuses.
  return [...n].length <= 150 && !n.includes('\u0000') ? { n, i } : null;
}

/** Where the next page of prices starts: after this row, newest first. A date and an id. */
function decodePriceCursor(cursor: string): { f: string; i: string } | null {
  const { f, i } = decode(cursor) ?? {};
  if (typeof f !== 'string' || typeof i !== 'string' || !UUID.test(i) || !isCalendarDate(f)) {
    return null;
  }
  return { f, i };
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

export interface ServiceSearch {
  q?: string;
  category?: ServiceCategory;
  archived: boolean;
  cursor?: string;
  limit: number;
}

/**
 * One page of the hospital's active (or archived) services, by name. Every word of the term must
 * be in the code or the name. The rows are found through the tenant index and the text matched
 * against those: a text index is never used under row-level security. Null for a bad cursor.
 */
export async function searchServices(
  client: pg.ClientBase,
  { q, category, archived, cursor, limit }: ServiceSearch,
  today: string,
): Promise<Page<ServiceRow> | null> {
  const after = cursor === undefined ? undefined : decodeServiceCursor(cursor);
  if (after === null) return null;

  const params: unknown[] = [archived];
  const where = ['s.archived = $1'];
  if (category) {
    params.push(category);
    where.push(`s.category = $${params.length}`);
  }
  for (const word of (q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(likePattern(word));
    // The database lower-cases both sides: its idea of lower case is not JavaScript's.
    where.push(`s.search_text like lower($${params.length})`);
  }
  const filters = params.length;

  params.push(today, after?.n ?? null, after?.i ?? null, limit + 1);
  const [todayAt, nameAt, idAt, limitAt] = [filters + 1, filters + 2, filters + 3, filters + 4];
  const { rows } = await client.query<ServiceRow>(
    `${servicesWithPrice(todayAt)}
     where ${where.join(' and ')}
       and ($${nameAt}::text is null or (s.name_lower, s.id) > ($${nameAt}, $${idAt}::uuid))
     order by s.name_lower, s.id
     limit $${limitAt}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: Page<ServiceRow> = {
    rows: page,
    nextCursor: rows.length > limit && last ? encode({ n: last.name_lower, i: last.id }) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from services s where ${where.join(' and ')}`,
      params.slice(0, filters),
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** The service with its price in force today, or null when this hospital has none such. */
export async function findService(
  client: pg.ClientBase,
  id: string,
  today: string,
): Promise<ServiceRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<ServiceRow>(`${servicesWithPrice(2)} where s.id = $1`, [
    id,
    today,
  ]);
  return rows[0] ?? null;
}

/** Whether this hospital has such a service. */
export async function serviceExists(client: pg.ClientBase, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await client.query('select 1 from services where id = $1', [id]);
  return rowCount === 1;
}

/** The service, locked until the transaction ends, or null when this hospital has none such. */
export async function lockService(
  client: pg.ClientBase,
  id: string,
): Promise<StoredService | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<StoredService>(
    `select ${STORED} from services where id = $1 for update`,
    [id],
  );
  return rows[0] ?? null;
}

/** Whether the hospital already has a service of this code, archived or not. */
export async function codeTaken(client: pg.ClientBase, code: string): Promise<boolean> {
  const { rowCount } = await client.query('select 1 from services where code_lower = lower($1)', [
    code,
  ]);
  return (rowCount ?? 0) > 0;
}

const violates = (error: unknown, code: string, constraint: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === code &&
  (error as { constraint?: unknown }).constraint === constraint;

/** Whether an error is the database refusing a second service of the same code. */
export const isCodeTaken = (error: unknown) => violates(error, '23505', 'services_code_taken');

/** Whether an error is the database refusing two prices of a service for the same day. */
export const isPriceOverlap = (error: unknown) =>
  violates(error, '23P01', 'service_prices_no_overlap');

export interface ServiceDetails {
  name: string;
  category: ServiceCategory;
  taxClass: TaxClass;
  modality: Modality | null;
  description: string | null;
}

export async function insertService(
  client: pg.ClientBase,
  input: ServiceDetails & { code: string },
): Promise<StoredService> {
  const { rows } = await client.query<StoredService>(
    `insert into services (tenant_id, code, name, category, tax_class, modality, description)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning ${STORED}`,
    [input.code, input.name, input.category, input.taxClass, input.modality, input.description],
  );
  const row = rows[0];
  if (!row) throw new Error('service was not created');
  return row;
}

export async function updateService(
  client: pg.ClientBase,
  id: string,
  changes: ServiceDetails,
): Promise<void> {
  const { rowCount } = await client.query(
    `update services set name = $2, category = $3, tax_class = $4, modality = $5, description = $6
     where id = $1`,
    [id, changes.name, changes.category, changes.taxClass, changes.modality, changes.description],
  );
  if (rowCount !== 1) throw new Error('service was not updated');
}

/** Archives or restores. False when the service is already as asked: nothing is written. */
export async function setArchived(
  client: pg.ClientBase,
  id: string,
  archived: boolean,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'update services set archived = $2 where id = $1 and archived <> $2',
    [id, archived],
  );
  return rowCount === 1;
}

export interface PriceListRow {
  id: string;
  name: string;
  standard: boolean;
}

/** The hospital's price lists, the standard one first. A hospital has few. */
export async function listPriceLists(client: pg.ClientBase): Promise<PriceListRow[]> {
  const { rows } = await client.query<PriceListRow>(
    'select id, name, standard from price_lists order by standard desc, name, id',
  );
  return rows;
}

/**
 * The id of the price list a request means: the one it names, when that is a list of this
 * hospital, or the standard list when it names none. Null when there is no such list.
 */
export async function priceListId(client: pg.ClientBase, named?: string): Promise<string | null> {
  if (named !== undefined && !UUID.test(named)) return null;
  const { rows } = await client.query<{ id: string }>(
    named === undefined
      ? 'select id from price_lists where standard'
      : 'select id from price_lists where id = $1',
    named === undefined ? [] : [named],
  );
  return rows[0]?.id ?? null;
}

/** The newest price of a service on a list that was not withdrawn: in force or scheduled. */
export async function latestPrice(
  client: pg.ClientBase,
  serviceId: string,
  listId: string,
): Promise<PriceRow | null> {
  const { rows } = await client.query<PriceRow>(
    `select ${PRICE_COLUMNS} from service_prices
     where service_id = $1 and price_list_id = $2 and withdrawn_at is null
     order by effective_from desc, id desc
     limit 1`,
    [serviceId, listId],
  );
  return rows[0] ?? null;
}

/** A price of this service that was not withdrawn, or null. */
export async function findPrice(
  client: pg.ClientBase,
  serviceId: string,
  priceId: string,
): Promise<PriceRow | null> {
  if (!UUID.test(priceId)) return null;
  const { rows } = await client.query<PriceRow>(
    `select ${PRICE_COLUMNS} from service_prices
     where id = $1 and service_id = $2 and withdrawn_at is null`,
    [priceId, serviceId],
  );
  return rows[0] ?? null;
}

/** Gives a price its last day, or takes it away again (null). Nothing else of a price changes. */
export async function setLastDay(
  client: pg.ClientBase,
  priceId: string,
  lastDay: string | null,
): Promise<void> {
  const { rowCount } = await client.query(
    'update service_prices set effective_to = $2::date where id = $1',
    [priceId, lastDay],
  );
  // Doing nothing here would leave the periods of a service wrong behind a success.
  if (rowCount !== 1) throw new Error('the last day of a price was not set');
}

/** The day before a date, by the calendar. */
export async function dayBefore(client: pg.ClientBase, date: string): Promise<string> {
  const { rows } = await client.query<{ day: string }>('select ($1::date - 1)::text as day', [
    date,
  ]);
  const day = rows[0]?.day;
  if (!day) throw new Error('could not work out the day before');
  return day;
}

export async function insertPrice(
  client: pg.ClientBase,
  input: { serviceId: string; listId: string; amountMinor: number; effectiveFrom: string },
): Promise<PriceRow> {
  const { rows } = await client.query<PriceRow>(
    `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
     values (app_tenant_id(), $1, $2, $3, $4::date)
     returning ${PRICE_COLUMNS}`,
    [input.serviceId, input.listId, input.amountMinor, input.effectiveFrom],
  );
  const row = rows[0];
  if (!row) throw new Error('price was not created');
  return row;
}

/** Marks a price withdrawn. The database refuses one that is or was in force. */
export async function withdrawPrice(client: pg.ClientBase, priceId: string): Promise<void> {
  const { rowCount } = await client.query(
    'update service_prices set withdrawn_at = now() where id = $1',
    [priceId],
  );
  if (rowCount !== 1) throw new Error('price was not withdrawn');
}

/** One page of the prices of a service on a list, newest first. Null for a bad cursor. */
export async function listPrices(
  client: pg.ClientBase,
  serviceId: string,
  listId: string,
  { cursor, limit }: { cursor?: string; limit: number },
): Promise<Page<PriceRow> | null> {
  const after = cursor === undefined ? undefined : decodePriceCursor(cursor);
  if (after === null) return null;
  const { rows } = await client.query<PriceRow>(
    `select ${PRICE_COLUMNS} from service_prices
     where service_id = $1 and price_list_id = $2 and withdrawn_at is null
       and ($3::date is null or (effective_from, id) < ($3::date, $4::uuid))
     order by effective_from desc, id desc
     limit $5`,
    [serviceId, listId, after?.f ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: Page<PriceRow> = {
    rows: page,
    nextCursor: rows.length > limit && last ? encode({ f: last.effective_from, i: last.id }) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from service_prices
       where service_id = $1 and price_list_id = $2 and withdrawn_at is null`,
      [serviceId, listId],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/**
 * For placing an imaging or procedure order: a service of the hospital in that category that is
 * not archived, with its code and name as they read now, or null. Exported from `index.ts`, so
 * the clinical module never reads this table itself.
 */
export async function orderableService(
  client: pg.ClientBase,
  id: string,
  category: ServiceCategory,
): Promise<{ id: string; code: string; name: string } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{ id: string; code: string; name: string }>(
    'select id, code, name from services where id = $1 and category = $2 and not archived',
    [id, category],
  );
  return rows[0] ?? null;
}
