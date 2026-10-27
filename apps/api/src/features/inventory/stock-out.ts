import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import {
  batchByNumber,
  findBatch,
  hospitalOnHand,
  insertBatch,
  isUuid,
  isViolation,
  lockItemStock,
  lockLocation,
  postEntry,
} from './repository.js';
import type { LedgerReason, LedgerSource } from './schemas.js';

/** A batch that may be given from a place: in date, with stock there. */
export interface UsableBatch {
  batchId: string;
  drugId: string;
  batchNumber: string;
  /** The last day it may be used, `YYYY-MM-DD`. */
  expiryDate: string;
  onHand: number;
  /** The printed maximum retail price in minor units, as text; null when not known. */
  mrpMinor: string | null;
}

/** Today at the hospital, as the database's calendar date. */
const TODAY = `(select (now() at time zone timezone)::date from tenants where id = app_tenant_id())`;

/**
 * For dispensing: the batches of these items with stock at the place that have not expired at the
 * hospital today, nearest expiry first, so the first one is the one to give first.
 */
export async function usableBatches(
  client: pg.ClientBase,
  drugIds: string[],
  locationId: string,
): Promise<UsableBatch[]> {
  const ids = drugIds.filter(isUuid);
  if (ids.length === 0 || !isUuid(locationId)) return [];
  const { rows } = await client.query<{
    batch_id: string;
    drug_id: string;
    batch_number: string;
    expiry_date: string;
    on_hand: number;
    mrp_minor: string | null;
  }>(
    `select b.batch_id, b.drug_id, t.batch_number, to_char(t.expiry_date, 'YYYY-MM-DD') as expiry_date,
       b.on_hand, t.mrp_minor::text as mrp_minor
     from stock_balances b
     join stock_batches t on t.tenant_id = b.tenant_id and t.id = b.batch_id
     where b.drug_id = any($1::uuid[]) and b.location_id = $2 and b.on_hand > 0
       and t.expiry_date >= ${TODAY}
     order by t.expiry_date, t.batch_key, b.batch_id`,
    [ids, locationId],
  );
  return rows.map((row) => ({
    batchId: row.batch_id,
    drugId: row.drug_id,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date,
    onHand: row.on_hand,
    mrpMinor: row.mrp_minor,
  }));
}

/**
 * Takes units of an item out of stock at a place, batch by batch, through the ledger, in the
 * request's transaction, for another module's record (`source` and `sourceId`): a dispense.
 *
 * Refuses a place that is not in use (422 `unknown_location`), a batch that is not the item's
 * (422 `unknown_batch`), a batch expired at the hospital today (409 `batch_expired`) unless
 * `expiredAllowed` (goods sent back to their supplier, #103) and more than a batch holds at the
 * place (409 `insufficient_stock`). Locks in inventory's order (the
 * place `for share`, the item's stock, then each balance), so the caller locks its own record
 * first; a caller moving several items takes them in id order, so two movements never wait for
 * each other. Emits `stock.low` when it brings the hospital's stock of the item from above its reorder
 * level to at or below it, as an approved adjustment does. Gives the ledger entry of each line.
 */
export async function stockOut(
  request: FastifyRequest,
  movement: {
    locationId: string;
    drugId: string;
    reorderLevel: number | null;
    source: LedgerSource;
    sourceId: string;
    reason: LedgerReason;
    actorId: string;
    lines: { batchId: string; quantity: number }[];
    /** Expired units may go: only when they go back to the supplier. */
    expiredAllowed?: boolean;
  },
): Promise<{ batchId: string; quantity: number; ledgerEntryId: string }[]> {
  const client = request.txClient;
  const location = await lockLocation(client, movement.locationId, 'share');
  if (!location || location.archived) {
    throw new HttpError(422, 'unknown_location', 'No such place in use');
  }
  const { rows } = await client.query<{ today: string }>(
    `select to_char(${TODAY}, 'YYYY-MM-DD') as today`,
  );
  const today = rows[0]?.today ?? '';
  for (const line of movement.lines) {
    const batch = await findBatch(client, line.batchId);
    if (!batch || batch.drug_id !== movement.drugId) {
      throw new HttpError(422, 'unknown_batch', 'No such batch of the item');
    }
    if (batch.expiry_date < today && !movement.expiredAllowed) {
      throw new HttpError(409, 'batch_expired', 'The batch is past its expiry date');
    }
  }
  // Held against another change of the item anywhere, so the reorder level is crossed once.
  await lockItemStock(client, movement.drugId);
  const before = await hospitalOnHand(client, movement.drugId);
  const posted: { batchId: string; quantity: number; ledgerEntryId: string }[] = [];
  for (const line of movement.lines) {
    try {
      const entry = await postEntry(client, {
        batchId: line.batchId,
        drugId: movement.drugId,
        locationId: movement.locationId,
        quantity: -line.quantity,
        source: movement.source,
        sourceId: movement.sourceId,
        reason: movement.reason,
        actorId: movement.actorId,
      });
      posted.push({ batchId: line.batchId, quantity: line.quantity, ledgerEntryId: entry.id });
    } catch (error) {
      if (isViolation(error, 'stock_balances_not_negative')) {
        throw new HttpError(
          409,
          'insufficient_stock',
          'The batch has fewer units at the place than that',
        );
      }
      throw error;
    }
  }
  const taken = movement.lines.reduce((sum, line) => sum + line.quantity, 0);
  const after = before - taken;
  const level = movement.reorderLevel;
  if (level !== null && after <= level && before > level) {
    await request.emit('stock.low', movement.drugId, { drugId: movement.drugId });
  }
  return posted;
}

/**
 * Puts units of an item back into stock at a place, batch by batch, through the ledger, in the
 * request's transaction, for another module's record: the return of a counter sale (#101).
 *
 * Refuses a place that is not in use (422 `unknown_location`), a batch that is not the item's
 * (422 `unknown_batch`) and a batch expired at the hospital today (409 `batch_expired`): an
 * expired unit brought back is wastage (#104), never stock. Locks as `stockOut` does. Gives the
 * ledger entry of each line.
 */
export async function stockIn(
  request: FastifyRequest,
  movement: {
    locationId: string;
    drugId: string;
    /** Only a return of a sale puts stock back this way: an adjustment is approved by another. */
    source: 'sale_return';
    sourceId: string;
    reason: 'sale_return';
    actorId: string;
    lines: { batchId: string; quantity: number }[];
  },
): Promise<{ batchId: string; quantity: number; ledgerEntryId: string }[]> {
  const client = request.txClient;
  if (movement.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) {
    throw new HttpError(400, 'validation_failed', 'Units brought back are a whole number above 0');
  }
  const location = await lockLocation(client, movement.locationId, 'share');
  if (!location || location.archived) {
    throw new HttpError(422, 'unknown_location', 'No such place in use');
  }
  const { rows } = await client.query<{ today: string }>(
    `select to_char(${TODAY}, 'YYYY-MM-DD') as today`,
  );
  const today = rows[0]?.today ?? '';
  for (const line of movement.lines) {
    const batch = await findBatch(client, line.batchId);
    if (!batch || batch.drug_id !== movement.drugId) {
      throw new HttpError(422, 'unknown_batch', 'No such batch of the item');
    }
    if (batch.expiry_date < today) {
      throw new HttpError(409, 'batch_expired', 'The batch is past its expiry date');
    }
  }
  await lockItemStock(client, movement.drugId);
  const posted: { batchId: string; quantity: number; ledgerEntryId: string }[] = [];
  for (const line of movement.lines) {
    const entry = await postEntry(client, {
      batchId: line.batchId,
      drugId: movement.drugId,
      locationId: movement.locationId,
      quantity: line.quantity,
      source: movement.source,
      sourceId: movement.sourceId,
      reason: movement.reason,
      actorId: movement.actorId,
    });
    posted.push({ batchId: line.batchId, quantity: line.quantity, ledgerEntryId: entry.id });
  }
  return posted;
}

/**
 * Brings goods received from a supplier into stock at a place (#103), in the request's
 * transaction: each line is a batch as printed on the pack, made when the item has no batch of
 * that number (whatever the capitals) and found when it has one of the same expiry date. Refuses
 * a place that is not in use (422 `unknown_location`), a number the item has with another expiry
 * (409 `batch_exists`) and a batch already expired at the hospital today (409 `batch_expired`).
 * A batch made here keeps the line's cost and maximum retail price; one found keeps its own, and
 * the receipt records what this delivery cost. Locks as `stockOut` does. Gives the batch and the
 * ledger entry of each line.
 */
export async function stockReceive(
  request: FastifyRequest,
  movement: {
    locationId: string;
    drugId: string;
    sourceId: string;
    actorId: string;
    lines: {
      batchNumber: string;
      expiryDate: string;
      mrpMinor: number | null;
      costMinor: number;
      quantity: number;
    }[];
  },
): Promise<{ batchId: string; quantity: number; ledgerEntryId: string }[]> {
  const client = request.txClient;
  const location = await lockLocation(client, movement.locationId, 'share');
  if (!location || location.archived) {
    throw new HttpError(422, 'unknown_location', 'No such place in use');
  }
  const { rows } = await client.query<{ today: string }>(
    `select to_char(${TODAY}, 'YYYY-MM-DD') as today`,
  );
  const today = rows[0]?.today ?? '';
  await lockItemStock(client, movement.drugId);
  const posted: { batchId: string; quantity: number; ledgerEntryId: string }[] = [];
  for (const line of movement.lines) {
    if (line.expiryDate < today) {
      throw new HttpError(409, 'batch_expired', 'The batch is past its expiry date');
    }
    const found = await batchByNumber(client, movement.drugId, line.batchNumber);
    const batch =
      found ??
      (await insertBatch(client, {
        drugId: movement.drugId,
        batchNumber: line.batchNumber,
        expiryDate: line.expiryDate,
        mrpMinor: line.mrpMinor === null ? null : String(line.mrpMinor),
        costMinor: String(line.costMinor),
        createdBy: movement.actorId,
      }));
    if (batch.expiry_date !== line.expiryDate) {
      throw new HttpError(
        409,
        'batch_exists',
        'The item has a batch of that number with another expiry',
      );
    }
    const entry = await postEntry(client, {
      batchId: batch.id,
      drugId: movement.drugId,
      locationId: movement.locationId,
      quantity: line.quantity,
      source: 'receipt',
      sourceId: movement.sourceId,
      reason: 'receipt',
      actorId: movement.actorId,
    });
    posted.push({ batchId: batch.id, quantity: line.quantity, ledgerEntryId: entry.id });
  }
  return posted;
}

/**
 * A place of the hospital that is in use, held (`for share`) until the transaction ends so it is
 * not archived meanwhile: for another module's record of where stock is to go (#103). Null for
 * one archived, of another hospital or none.
 */
export async function placeInUse(
  client: pg.ClientBase,
  locationId: string,
): Promise<{ id: string; name: string } | null> {
  const location = await lockLocation(client, locationId, 'share');
  return location && !location.archived ? { id: location.id, name: location.name } : null;
}
