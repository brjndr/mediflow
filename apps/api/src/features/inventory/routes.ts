import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { stockableDrug } from '../drugs/index.js';
import {
  alertCounts,
  batchBalances,
  batchByNumber,
  decideAdjustment,
  findAdjustment,
  findBatch,
  findLocation,
  hospitalOnHand,
  insertAdjustment,
  insertBatch,
  insertLocation,
  isUuid,
  isViolation,
  listAdjustments,
  listLedger,
  listLocations,
  listStock,
  locationHasStock,
  locationNameTaken,
  lockAdjustment,
  lockItemStock,
  lockLocation,
  onHandAt,
  postEntry,
  updateLocation,
  type AdjustmentRow,
  type BatchBalanceRow,
  type ItemColumns,
  type LedgerRow,
  type LocationRow,
} from './repository.js';
import {
  EXPIRING_DAYS_DEFAULT,
  INVENTORY_SCHEMAS,
  LOCATION_NAME_MAX,
  NOTE_MAX,
  StockAdjustment,
  StockAdjustmentApprove,
  StockAdjustmentCreate,
  StockAdjustmentListQuery,
  StockAdjustmentPage,
  StockAdjustmentReject,
  StockAlertCounts,
  StockAlertQuery,
  StockItemPage,
  StockLedgerPage,
  StockLedgerQuery,
  StockListQuery,
  StockLocation,
  StockLocationCreate,
  StockLocationListQuery,
  StockLocationPage,
  StockLocationUpdate,
  type AdjustmentStatus,
  type StockAlert,
  type StockBatchBalance,
  type StockItemName,
  type StockLedgerEntry,
} from './schemas.js';

export const FEATURE = 'inventory';

const READ = 'stock:read';
const ADJUST = 'stock:adjust';
const APPROVE = 'stock:approve';
const MANAGE_LOCATIONS = 'stockLocation:manage';

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const conflict = () => new HttpError(409, 'conflict', 'It has changed since it was read');
const insufficient = () =>
  new HttpError(409, 'insufficient_stock', 'The batch has fewer units at the place than that');
const locationGone = () => new HttpError(404, 'location_not_found', 'No such place');
const adjustmentGone = () => new HttpError(404, 'adjustment_not_found', 'No such adjustment');
const badCursor = () => new HttpError(400, 'invalid_cursor', 'Unknown cursor');

const optional = <Key extends string, Value>(key: Key, value: Value | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

/** A uuid from the query, or null; anything else matches nothing, as another hospital's id. */
const idOrNull = (value: string | undefined): string | null | false =>
  value === undefined ? null : isUuid(value) ? value.toLowerCase() : false;

const itemView = (row: ItemColumns): StockItemName => ({
  drugId: row.drug_id,
  type: row.drug_type,
  genericName: row.generic_name,
  ...optional('brandName', row.brand_name),
  form: row.form,
  ...optional('strength', row.strength),
  ...optional('unit', row.unit),
});

const locationView = (row: LocationRow): StockLocation => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  kind: row.kind,
  archived: row.archived,
  version: row.version,
});

const batchView = (row: BatchBalanceRow): StockBatchBalance => ({
  batchId: row.batch_id,
  batchNumber: row.batch_number,
  expiryDate: row.expiry_date,
  ...optional('mrpMinor', row.mrp_minor === null ? null : Number(row.mrp_minor)),
  locationId: row.location_id,
  locationName: row.location_name,
  onHand: row.on_hand,
  expiry: row.expiry,
});

const ledgerView = (row: LedgerRow): StockLedgerEntry => ({
  id: row.id,
  at: row.at.toISOString(),
  item: itemView(row),
  batchId: row.batch_id,
  batchNumber: row.batch_number,
  expiryDate: row.expiry_date,
  locationId: row.location_id,
  locationName: row.location_name,
  quantity: row.quantity,
  balanceAfter: row.balance_after,
  source: row.source,
  sourceId: row.source_id,
  reason: row.reason,
  actorName: row.actor_name ?? '',
});

const adjustmentView = (row: AdjustmentRow): StockAdjustment => ({
  id: row.id,
  tenantId: row.tenant_id,
  locationId: row.location_id,
  locationName: row.location_name,
  item: itemView(row),
  ...optional('batchId', row.batch_id),
  batchNumber: row.batch_number,
  expiryDate: row.expiry_date,
  newBatch: row.new_batch,
  ...optional('mrpMinor', row.mrp_minor === null ? null : Number(row.mrp_minor)),
  ...optional('costMinor', row.cost_minor === null ? null : Number(row.cost_minor)),
  quantity: row.quantity,
  reason: row.reason,
  ...optional('note', row.note),
  onHand: row.on_hand,
  status: row.status,
  requestedById: row.requested_by,
  requestedByName: row.requested_by_name ?? '',
  requestedAt: row.requested_at.toISOString(),
  ...optional('decidedByName', row.decided_by_name),
  ...optional('decidedAt', row.decided_at?.toISOString()),
  ...optional('rejectionNote', row.rejection_note),
  version: row.version,
});

/** A name as it is stored, and not empty once it is tidied. */
function cleanName(name: string): string {
  const tidied = tidyWithin(name, LOCATION_NAME_MAX);
  if (tidied === '') throw invalid('A name is required');
  return tidied;
}

/** Whether a calendar date sent as YYYY-MM-DD is a real day. */
function realDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const inventoryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of INVENTORY_SCHEMAS) app.addSchema(schema);

  const LocationParams = Type.Object({ locationId: Type.String({ maxLength: 64 }) });
  const AdjustmentParams = Type.Object({ adjustmentId: Type.String({ maxLength: 64 }) });

  // --- places ----------------------------------------------------------------------------------

  app.get(
    '/inventory/locations',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listStockLocations',
        tags: ['inventory'],
        description:
          'The places of the active tenant that keep stock, in use (or archived), by name. `total` comes with the first page.',
        querystring: StockLocationListQuery,
        response: { 200: ref(StockLocationPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, archived = false } = request.query;
      const list = await listLocations(request.txClient, { archived, cursor, limit });
      if (!list) throw badCursor();
      return {
        items: list.rows.map(locationView),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  const nameTaken = () =>
    new HttpError(409, 'location_name_taken', 'The hospital has a place of that name');

  app.post(
    '/inventory/locations',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: {
        permissions: [MANAGE_LOCATIONS, READ],
        feature: FEATURE,
        idempotent: { body: 'full' },
      },
      schema: {
        operationId: 'createStockLocation',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Adds a place that keeps stock. A name the hospital already has, archived or not, whatever the capitals, is 409 location_name_taken. Audited.',
        body: ref(StockLocationCreate),
        response: { 201: ref(StockLocation), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as StockLocationCreate;
      const name = cleanName(body.name);
      if (await locationNameTaken(request.txClient, name)) throw nameTaken();
      let id: string;
      try {
        id = await insertLocation(request.txClient, { name, kind: body.kind });
      } catch (error) {
        if (isViolation(error, 'stock_locations_name_taken')) throw nameTaken();
        throw error;
      }
      request.audit('create', 'stock_location', id);
      const row = await findLocation(request.txClient, id);
      if (!row) throw locationGone();
      return reply.status(201).send(locationView(row));
    },
  );

  app.patch(
    '/inventory/locations/:locationId',
    {
      config: { permissions: [MANAGE_LOCATIONS, READ], feature: FEATURE },
      schema: {
        operationId: 'updateStockLocation',
        tags: ['inventory'],
        description:
          'Renames a place or changes its kind. 409 conflict when it changed since the version sent; 409 location_name_taken as on adding. Sending what it has changes nothing. Audited. A place of another hospital answers 404, the same as one that does not exist.',
        params: LocationParams,
        body: ref(StockLocationUpdate),
        response: { 200: ref(StockLocation), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as StockLocationUpdate;
      const current = await lockLocation(request.txClient, request.params.locationId);
      if (!current) throw locationGone();
      if (current.version !== body.expectedVersion) throw conflict();
      const name = body.name === undefined ? current.name : cleanName(body.name);
      const kind = body.kind ?? current.kind;
      if (name !== current.name && (await locationNameTaken(request.txClient, name, current.id))) {
        throw nameTaken();
      }
      if (name !== current.name || kind !== current.kind) {
        try {
          await updateLocation(request.txClient, current.id, {
            name,
            kind,
            archived: current.archived,
          });
        } catch (error) {
          if (isViolation(error, 'stock_locations_name_taken')) throw nameTaken();
          throw error;
        }
        request.audit('update', 'stock_location', current.id);
      }
      const row = await findLocation(request.txClient, current.id);
      if (!row) throw locationGone();
      return locationView(row);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/inventory/locations/:locationId/${action}`,
      {
        config: { permissions: [MANAGE_LOCATIONS, READ], feature: FEATURE },
        schema: {
          operationId: `${action}StockLocation`,
          tags: ['inventory'],
          description:
            (action === 'archive'
              ? 'Archives a place: no stock is moved there any more. Refused with 409 location_has_stock while any batch has stock there.'
              : 'Brings an archived place back.') +
            ' Doing it twice changes nothing. Audited. A place of another hospital answers 404.',
          params: LocationParams,
          response: { 200: ref(StockLocation), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const archive = action === 'archive';
        // Held against stock being moved there at the same moment (`for share` there).
        const current = await lockLocation(request.txClient, request.params.locationId);
        if (!current) throw locationGone();
        if (current.archived !== archive) {
          if (archive && (await locationHasStock(request.txClient, current.id))) {
            throw new HttpError(409, 'location_has_stock', 'A batch has stock at this place');
          }
          await updateLocation(request.txClient, current.id, { ...current, archived: archive });
          request.audit(action, 'stock_location', current.id);
        }
        const row = await findLocation(request.txClient, current.id);
        if (!row) throw locationGone();
        return locationView(row);
      },
    );
  }

  // --- stock -----------------------------------------------------------------------------------

  app.get(
    '/inventory/stock',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listStock',
        tags: ['inventory'],
        description:
          'The items in use of the drug and consumable master with their stock, by generic name then brand: units on hand at the place asked (or the whole hospital) and at the whole hospital, whether the hospital’s stock is low (at or below the item’s reorder level, whatever the place), and the batches with stock at the place, soonest expiry first. `alert` narrows to low, expiring or expired items; a batch is expired the day after its expiry date at the hospital. `total` comes with the first page. No patient data: a GET.',
        querystring: StockListQuery,
        response: { 200: ref(StockItemPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query;
      const locationId = idOrNull(query.locationId);
      const drugId = idOrNull(query.drugId);
      const empty = { items: [], nextCursor: null, total: 0 };
      if (locationId === false || drugId === false) return empty;
      const expiringWithinDays = query.expiringWithinDays ?? EXPIRING_DAYS_DEFAULT;
      const list = await listStock(request.txClient, {
        locationId,
        drugId,
        alert: (query.alert as StockAlert | undefined) ?? null,
        expiringWithinDays,
        cursor: query.cursor,
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!list) throw badCursor();
      const batches = await batchBalances(request.txClient, {
        drugIds: list.rows.map((row) => row.drug_id),
        locationId,
        expiringWithinDays,
      });
      return {
        items: list.rows.map((row) => ({
          item: itemView(row),
          ...optional('reorderLevel', row.reorder_level),
          onHand: row.on_hand,
          hospitalOnHand: row.hospital_on_hand,
          low: row.reorder_level !== null && row.hospital_on_hand <= row.reorder_level,
          batches: batches.filter((batch) => batch.drug_id === row.drug_id).map(batchView),
        })),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  app.get(
    '/inventory/stock/alerts',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getStockAlerts',
        tags: ['inventory'],
        description:
          'How many items are low (the whole hospital’s stock), and have stock expiring or expired at the place asked (or anywhere): the counts of the stock list’s alerts.',
        querystring: StockAlertQuery,
        response: { 200: ref(StockAlertCounts), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const locationId = idOrNull(request.query.locationId);
      if (locationId === false) return { low: 0, expiring: 0, expired: 0 };
      return alertCounts(request.txClient, {
        locationId,
        expiringWithinDays: request.query.expiringWithinDays ?? EXPIRING_DAYS_DEFAULT,
      });
    },
  );

  app.get(
    '/inventory/ledger',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listStockLedger',
        tags: ['inventory'],
        description:
          'Every change of stock, newest first, of an item, a batch and a place, from and to an instant when asked. Append-only: a correction is a later entry. No `total`: the ledger only grows.',
        querystring: StockLedgerQuery,
        response: { 200: ref(StockLedgerPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query;
      const drugId = idOrNull(query.drugId);
      const batchId = idOrNull(query.batchId);
      const locationId = idOrNull(query.locationId);
      if (drugId === false || batchId === false || locationId === false) {
        return { items: [], nextCursor: null };
      }
      const list = await listLedger(request.txClient, {
        drugId,
        batchId,
        locationId,
        from: query.from ?? null,
        to: query.to ?? null,
        cursor: query.cursor,
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!list) throw badCursor();
      return { items: list.rows.map(ledgerView), nextCursor: list.nextCursor };
    },
  );

  // --- adjustments -----------------------------------------------------------------------------

  app.get(
    '/inventory/adjustments',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listStockAdjustments',
        tags: ['inventory'],
        description:
          'The adjustments of a status (pending when not sent), newest asked first, each with the batch’s stock at its place now. `total` comes with the first page.',
        querystring: StockAdjustmentListQuery,
        response: { 200: ref(StockAdjustmentPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const status = (request.query.status as AdjustmentStatus | undefined) ?? 'pending';
      const list = await listAdjustments(request.txClient, { status, cursor, limit });
      if (!list) throw badCursor();
      return {
        items: list.rows.map(adjustmentView),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  /** The place stock is moved at: of the hospital and in use, held so it is not archived meanwhile. */
  async function placeInUse(request: FastifyRequest, locationId: string): Promise<LocationRow> {
    const location = await lockLocation(request.txClient, locationId, 'share');
    if (!location || location.archived) {
      throw invalid('locationId is not a place of this hospital that is in use');
    }
    return location;
  }

  app.post(
    '/inventory/adjustments',
    {
      // Names of items, places and staff only, no patient data: a replay returns it whole.
      config: { permissions: [ADJUST, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createStockAdjustment',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Asks for a stock adjustment, which waits for someone else to approve it: nothing moves yet. The place must be in use and the item in use (400). Either a batch of the item (`batchId`), or a new batch (`batchNumber` and `expiryDate`, with `mrpMinor` and `costMinor` when known) for opening stock only; a new batch whose number the item already has is 409 batch_exists, to be chosen instead. Opening stock is positive, damaged and expired stock negative, a count correction and other either way, never 0 (400). Taking out more than the batch has at the place now is 409 insufficient_stock (checked again on approval). Audited.',
        body: ref(StockAdjustmentCreate),
        response: { 201: ref(StockAdjustment), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as StockAdjustmentCreate;
      const requestedBy = userIdOf(request);
      const location = await placeInUse(request, body.locationId);
      const drug = await stockableDrug(request.txClient, body.drugId);
      if (!drug) throw invalid('drugId is not an item of this hospital that is in use');
      if (body.quantity === 0) throw invalid('A quantity of 0 changes nothing');
      if (body.reason === 'opening' && body.quantity < 0) {
        throw invalid('Opening stock is brought in: a positive quantity');
      }
      if ((body.reason === 'damaged' || body.reason === 'expired') && body.quantity > 0) {
        throw invalid('Damaged and expired stock is taken out: a negative quantity');
      }
      const describesBatch =
        body.batchNumber !== undefined ||
        body.expiryDate !== undefined ||
        body.mrpMinor !== undefined ||
        body.costMinor !== undefined;
      let batchId: string | null = null;
      let batchNumber: string | null = null;
      if (body.batchId !== undefined) {
        if (describesBatch) throw invalid('Name a batch, or describe a new one, not both');
        const batch = await findBatch(request.txClient, body.batchId);
        if (!batch || batch.drug_id !== drug.id) {
          throw invalid('batchId is not a batch of this item');
        }
        batchId = batch.id;
        if (
          body.quantity < 0 &&
          (await onHandAt(request.txClient, batch.id, location.id)) < -body.quantity
        ) {
          throw insufficient();
        }
      } else {
        if (body.reason !== 'opening') throw invalid('Only opening stock may bring in a new batch');
        if (body.batchNumber === undefined || body.expiryDate === undefined) {
          throw invalid('A new batch needs its number and expiry date');
        }
        if (!realDay(body.expiryDate)) throw invalid('expiryDate is not a day');
        batchNumber = tidyWithin(body.batchNumber, 40);
        if (batchNumber === '') throw invalid('A batch number is required');
        if (await batchByNumber(request.txClient, drug.id, batchNumber)) {
          throw new HttpError(409, 'batch_exists', 'The item has a batch of that number');
        }
      }
      const id = await insertAdjustment(request.txClient, {
        locationId: location.id,
        drugId: drug.id,
        batchId,
        batchNumber,
        expiryDate: batchId ? null : (body.expiryDate ?? null),
        mrpMinor: batchId ? null : (body.mrpMinor ?? null),
        costMinor: batchId ? null : (body.costMinor ?? null),
        quantity: body.quantity,
        reason: body.reason,
        note: tidyOptional(body.note, NOTE_MAX),
        requestedBy,
      });
      request.audit('create', 'stock_adjustment', id);
      const row = await findAdjustment(request.txClient, id);
      if (!row) throw adjustmentGone();
      return reply.status(201).send(adjustmentView(row));
    },
  );

  /** The pending adjustment, locked, at the version sent, and someone else's. */
  async function toDecide(
    request: FastifyRequest,
    adjustmentId: string,
    expectedVersion: number,
    decidedBy: string,
  ): Promise<AdjustmentRow> {
    const current = await lockAdjustment(request.txClient, adjustmentId);
    if (!current) throw adjustmentGone();
    if (current.status !== 'pending') {
      throw new HttpError(409, 'adjustment_decided', 'The adjustment was decided already');
    }
    if (current.version !== expectedVersion) throw conflict();
    if (current.requested_by === decidedBy) {
      throw new HttpError(
        409,
        'own_adjustment',
        'Someone else decides an adjustment you asked for',
      );
    }
    return current;
  }

  app.post(
    '/inventory/adjustments/:adjustmentId/approve',
    {
      config: { permissions: [APPROVE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'approveStockAdjustment',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Approves a pending adjustment someone else asked for (409 own_adjustment), at its version (409 conflict): it moves the stock through the ledger, making the new batch of opening stock first (409 batch_exists when a batch of that number with another expiry was made meanwhile). Refused with 409 insufficient_stock when the batch has fewer units at the place than it takes out, 409 location_archived when its place was archived, 409 item_archived when its item was, 409 adjustment_decided once decided. Emits `stock.adjusted`, and `stock.low` when it brings the hospital’s stock of the item to its reorder level or below. Audited.',
        params: AdjustmentParams,
        body: ref(StockAdjustmentApprove),
        response: { 200: ref(StockAdjustment), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as StockAdjustmentApprove;
      const decidedBy = userIdOf(request);
      const current = await toDecide(
        request,
        request.params.adjustmentId,
        body.expectedVersion,
        decidedBy,
      );
      const location = await lockLocation(request.txClient, current.location_id, 'share');
      if (!location || location.archived) {
        throw new HttpError(409, 'location_archived', 'The place was archived');
      }
      // Stock of an item archived since it was asked for is not moved: the stock list no longer
      // shows it.
      const drug = await stockableDrug(request.txClient, current.drug_id);
      if (!drug) throw new HttpError(409, 'item_archived', 'The item was archived');
      // Held against another approval of the item, so the hospital's stock before and after this
      // one is known and the reorder level is crossed by one approval only.
      await lockItemStock(request.txClient, current.drug_id);
      const before = await hospitalOnHand(request.txClient, current.drug_id);
      let batchId = current.batch_id;
      if (batchId === null) {
        const batch = await insertBatch(request.txClient, {
          drugId: current.drug_id,
          batchNumber: current.batch_number,
          expiryDate: current.expiry_date,
          mrpMinor: current.mrp_minor,
          costMinor: current.cost_minor,
          createdBy: decidedBy,
        });
        if (batch.expiry_date !== current.expiry_date) {
          throw new HttpError(409, 'batch_exists', 'A batch of that number has another expiry');
        }
        batchId = batch.id;
      }
      let entry: { id: string };
      try {
        entry = await postEntry(request.txClient, {
          batchId,
          drugId: current.drug_id,
          locationId: current.location_id,
          quantity: current.quantity,
          source: 'adjustment',
          sourceId: current.id,
          reason: current.reason,
          actorId: decidedBy,
        });
      } catch (error) {
        if (isViolation(error, 'stock_balances_not_negative')) throw insufficient();
        throw error;
      }
      await decideAdjustment(request.txClient, current.id, {
        status: 'approved',
        decidedBy,
        batchId,
        rejectionNote: null,
      });
      request.audit('update', 'stock_adjustment', current.id);
      await request.emit('stock.adjusted', current.id, {
        adjustmentId: current.id,
        ledgerEntryId: entry.id,
        drugId: current.drug_id,
        batchId,
        locationId: current.location_id,
        reason: current.reason,
      });
      const reorderLevel = drug.reorderLevel;
      const after = before + current.quantity;
      if (reorderLevel !== null && after <= reorderLevel && before > reorderLevel) {
        await request.emit('stock.low', current.drug_id, { drugId: current.drug_id });
      }
      const row = await findAdjustment(request.txClient, current.id);
      if (!row) throw adjustmentGone();
      return adjustmentView(row);
    },
  );

  app.post(
    '/inventory/adjustments/:adjustmentId/reject',
    {
      config: { permissions: [APPROVE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'rejectStockAdjustment',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Rejects a pending adjustment someone else asked for, with a note saying why: nothing moves. The same refusals as approving, apart from those of stock. Audited.',
        params: AdjustmentParams,
        body: ref(StockAdjustmentReject),
        response: { 200: ref(StockAdjustment), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as StockAdjustmentReject;
      const decidedBy = userIdOf(request);
      const note = tidyWithin(body.note, NOTE_MAX);
      if (note === '') throw invalid('Say why it is rejected');
      const current = await toDecide(
        request,
        request.params.adjustmentId,
        body.expectedVersion,
        decidedBy,
      );
      await decideAdjustment(request.txClient, current.id, {
        status: 'rejected',
        decidedBy,
        batchId: null,
        rejectionNote: note,
      });
      request.audit('update', 'stock_adjustment', current.id);
      const row = await findAdjustment(request.txClient, current.id);
      if (!row) throw adjustmentGone();
      return adjustmentView(row);
    },
  );
};
