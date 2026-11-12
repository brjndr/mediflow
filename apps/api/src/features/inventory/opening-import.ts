import { randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { PLAIN_TEXT, tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RowProblem, type ImportKind } from '../../core/imports/registry.js';
import {
  batchByNumber,
  insertBatch,
  lockItemStock,
  lockLocation,
  postEntry,
  TODAY,
} from './repository.js';
import { BATCH_NUMBER_MAX, QUANTITY_MAX } from './schemas.js';

/** What one row of an opening stock file says, checked and ready to write. */
export interface OpeningStockRow {
  drugId: string;
  locationId: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  mrpMinor: string | null;
  costMinor: string | null;
}

const MONEY_MAX = 1_000_000_000_000;

const OpeningStockBody = Type.Object(
  {
    genericName: Type.String({ minLength: 1, maxLength: 200 }),
    brandName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    form: Type.String({ minLength: 1, maxLength: 40 }),
    strength: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    location: Type.String({ minLength: 1, maxLength: 120 }),
    batchNumber: Type.String({ minLength: 1, maxLength: BATCH_NUMBER_MAX, pattern: PLAIN_TEXT }),
    expiryDate: Type.String({ format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    quantity: Type.Integer({ minimum: 1, maximum: QUANTITY_MAX }),
    costMinor: Type.Optional(Type.Integer({ minimum: 0, maximum: MONEY_MAX })),
    mrpMinor: Type.Optional(Type.Integer({ minimum: 0, maximum: MONEY_MAX })),
  },
  { additionalProperties: false },
);
type OpeningStockBody = Static<typeof OpeningStockBody>;

const realDay = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const fold = (param: string) => `lower(translate(${param}, chr(8204) || chr(8205), ''))`;

/** The item in use a row names by generic name, brand, form and strength, as the drug master keeps them. */
async function itemNamed(
  client: pg.ClientBase,
  name: { genericName: string; brandName: string | null; form: string; strength: string | null },
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `select id from drugs
     where not archived and generic_key = ${fold('$1')} and brand_key = ${fold("coalesce($2, '')")}
       and form = lower($3) and strength_key = ${fold("coalesce($4, '')")}`,
    [name.genericName, name.brandName, name.form, name.strength],
  );
  return rows[0]?.id ?? null;
}

async function placeNamed(client: pg.ClientBase, name: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'select id from stock_locations where name_lower = lower($1) and not archived',
    [name],
  );
  return rows[0]?.id ?? null;
}

/** Whether the batch already has opening stock at the place: a file loaded twice would double it. */
async function openedAt(
  client: pg.ClientBase,
  batchId: string,
  locationId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    "select 1 from stock_ledger where batch_id = $1 and location_id = $2 and reason = 'opening' limit 1",
    [batchId, locationId],
  );
  return (rowCount ?? 0) > 0;
}

async function today(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `select to_char(${TODAY}, 'YYYY-MM-DD') as today`,
  );
  return rows[0]?.today ?? '';
}

/**
 * Brings opening stock into a place through the ledger (the reason `opening`), making the batch
 * when the item has none of that number. Locks as `stockOut` does. Refusals are the row's
 * problems: a place not in use, an expired batch, a number the item has with another expiry, and
 * a batch that already has opening stock at the place.
 */
export async function stockOpening(
  client: pg.ClientBase,
  row: OpeningStockRow,
  actorId: string,
): Promise<{ batchId: string; ledgerEntryId: string }> {
  const location = await lockLocation(client, row.locationId, 'share');
  if (!location || location.archived) throw new RowProblem('location', 'unknown_location');
  if (row.expiryDate < (await today(client))) throw new RowProblem('expiryDate', 'batch_expired');
  await lockItemStock(client, row.drugId);
  const found = await batchByNumber(client, row.drugId, row.batchNumber);
  if (found && found.expiry_date !== row.expiryDate) {
    throw new RowProblem('batchNumber', 'batch_exists');
  }
  if (found && (await openedAt(client, found.id, row.locationId))) {
    throw new RowProblem('batchNumber', 'opening_exists');
  }
  const batch =
    found ??
    (await insertBatch(client, {
      drugId: row.drugId,
      batchNumber: row.batchNumber,
      expiryDate: row.expiryDate,
      mrpMinor: row.mrpMinor,
      costMinor: row.costMinor,
      createdBy: actorId,
    }));
  const entry = await postEntry(client, {
    batchId: batch.id,
    drugId: row.drugId,
    locationId: row.locationId,
    quantity: row.quantity,
    source: 'adjustment',
    sourceId: randomUUID(),
    reason: 'opening',
    actorId,
  });
  return { batchId: batch.id, ledgerEntryId: entry.id };
}

/**
 * Opening stock loaded from a file by the import centre (#692): one row a batch at a place.
 * Checked as an opening adjustment is, and written through the ledger.
 */
export const openingStockImport: ImportKind<OpeningStockRow> = {
  kind: 'opening_stock',
  feature: 'inventory',
  permissions: ['stock:read', 'stock:adjust', 'stock:approve'],
  body: OpeningStockBody,
  columns: [
    { field: 'genericName', required: true, type: 'text' },
    { field: 'brandName', required: false, type: 'text' },
    { field: 'form', required: true, type: 'text' },
    { field: 'strength', required: false, type: 'text' },
    { field: 'location', required: true, type: 'text' },
    { field: 'batchNumber', required: true, type: 'text' },
    { field: 'expiryDate', required: true, type: 'date' },
    { field: 'quantity', required: true, type: 'integer' },
    { field: 'costMinor', required: false, type: 'amount' },
    { field: 'mrpMinor', required: false, type: 'amount' },
  ],
  async prepare(writer, raw) {
    const body = raw as unknown as OpeningStockBody;
    const client = writer.txClient;
    const drugId = await itemNamed(client, {
      genericName: tidyWithin(body.genericName, 200),
      brandName: tidyOptional(body.brandName, 200),
      form: tidyWithin(body.form, 40),
      strength: tidyOptional(body.strength, 80),
    });
    if (!drugId) throw new RowProblem('genericName', 'unknown_item');
    const locationId = await placeNamed(client, tidyWithin(body.location, 120));
    if (!locationId) throw new RowProblem('location', 'unknown_location');
    const batchNumber = tidyWithin(body.batchNumber, BATCH_NUMBER_MAX);
    if (batchNumber === '') throw new RowProblem('batchNumber', 'validation_failed');
    if (!realDay(body.expiryDate)) throw new RowProblem('expiryDate', 'validation_failed');
    if (body.expiryDate < (await today(client))) {
      throw new RowProblem('expiryDate', 'batch_expired');
    }
    const found = await batchByNumber(client, drugId, batchNumber);
    if (found && found.expiry_date !== body.expiryDate) {
      throw new RowProblem('batchNumber', 'batch_exists');
    }
    if (found && (await openedAt(client, found.id, locationId))) {
      throw new RowProblem('batchNumber', 'opening_exists');
    }
    return {
      value: {
        drugId,
        locationId,
        batchNumber,
        expiryDate: body.expiryDate,
        quantity: body.quantity,
        mrpMinor: body.mrpMinor === undefined ? null : String(body.mrpMinor),
        costMinor: body.costMinor === undefined ? null : String(body.costMinor),
      },
      // Two lines of one batch at one place in a file would be loaded twice.
      key: `${drugId}\u0000${batchNumber.toUpperCase()}\u0000${locationId}`,
    };
  },
  async write(writer, value, actorId) {
    let ledgerEntryId: string;
    try {
      ({ ledgerEntryId } = await stockOpening(writer.txClient, value, actorId));
    } catch (error) {
      // What the check passed and the write refuses is a refusal of the row, whole.
      if (error instanceof RowProblem) throw new HttpError(409, error.code, 'Row refused');
      throw error;
    }
    writer.audit('create', 'stock_opening', ledgerEntryId);
  },
};
