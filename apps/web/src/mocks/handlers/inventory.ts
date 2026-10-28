import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { todayIn } from '@/shared/utils/timezone';
import { currentSession, mockTenantTimezone, onMockReset, TENANT_IDS, USER_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDrug, mockDrugsOf } from './drugs';

type Drug = components['schemas']['Drug'];
type StockLocation = components['schemas']['StockLocation'];
type StockItem = components['schemas']['StockItem'];
type StockItemName = components['schemas']['StockItemName'];
type StockBatchBalance = components['schemas']['StockBatchBalance'];
type StockAdjustment = components['schemas']['StockAdjustment'];
type StockLedgerEntry = components['schemas']['StockLedgerEntry'];
type Reason = StockAdjustment['reason'];
type Status = StockAdjustment['status'];

const FEATURE_FLAG = 'inventory';
const READ = 'stock:read';
const ADJUST = 'stock:adjust';
const APPROVE = 'stock:approve';
const MANAGE = 'stockLocation:manage';
const REASONS: readonly Reason[] = ['opening', 'count_correction', 'damaged', 'expired', 'other'];
const KINDS: readonly StockLocation['kind'][] = ['store', 'pharmacy', 'ward'];
const EXPIRING_DAYS = 90;
const DAY_MS = 86_400_000;

interface Batch {
  id: string;
  tenantId: string;
  drugId: string;
  batchNumber: string;
  expiryDate: string;
  mrpMinor?: number;
}

/** A batch's units at a place. */
interface Balance {
  tenantId: string;
  batchId: string;
  locationId: string;
  onHand: number;
}

/** An adjustment as the mock holds it: who asked by id, so the two-person rule can be checked. */
type Adjustment = StockAdjustment & { requestedById: string };

/**
 * Inventory (#102), as the API: places, batches, balances moved only through the ledger, and
 * adjustments asked for by one person and decided by another. At the hospital: two places,
 * opening stock of the first items of the drugs mock (one batch expiring within the month, a
 * few items low), and two adjustments the store keeper asked for, waiting for the admin.
 */
function seed() {
  const state = {
    locations: [] as StockLocation[],
    batches: [] as Batch[],
    balances: [] as Balance[],
    ledger: [] as StockLedgerEntry[],
    adjustments: [] as Adjustment[],
    answered: new Map<string, { body: string; reply: unknown; status: number }>(),
    counter: 0,
  };
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  const day = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
  const place = (id: string, tenantId: string, name: string, kind: StockLocation['kind']) =>
    state.locations.push({ id, tenantId, name, kind, archived: false, version: 1 });
  place('loc_h_store', TENANT_IDS.hospital, 'Main store', 'store');
  place('loc_h_pharmacy', TENANT_IDS.hospital, 'Pharmacy counter', 'pharmacy');
  place('loc_c_store', TENANT_IDS.clinic, 'Clinic store', 'store');

  const stocked = [...mockDrugsOf(TENANT_IDS.hospital)].sort(byName).slice(0, 30);
  for (const [index, drug] of stocked.entries()) {
    const quantity = index % 5 === 0 ? 20 : 400;
    for (const [locationId, share, suffix] of [
      ['loc_h_store', 0.75, 'A'],
      ['loc_h_pharmacy', 0.25, 'B'],
    ] as const) {
      const batch: Batch = {
        id: `bat_h_${index + 1}${suffix}`,
        tenantId: TENANT_IDS.hospital,
        drugId: drug.id,
        batchNumber: `SB${String(index + 1).padStart(3, '0')}${suffix}`,
        expiryDate: day(index === 2 ? 20 : 300 + index * 7),
        mrpMinor: drug.type === 'medicine' ? 4500 : 1200,
      };
      state.batches.push(batch);
      const units = Math.round(quantity * share);
      const adjustmentId = `adj_h_open_${index + 1}${suffix}`;
      state.adjustments.push({
        ...adjustmentView(drug, batch, locationId, 'Main store'),
        id: adjustmentId,
        tenantId: TENANT_IDS.hospital,
        locationName: locationId === 'loc_h_store' ? 'Main store' : 'Pharmacy counter',
        newBatch: true,
        quantity: units,
        reason: 'opening',
        onHand: units,
        status: 'approved',
        requestedById: USER_IDS.storeKeeper,
        requestedByName: 'Sample Store Keeper',
        requestedAt: at(30),
        decidedByName: 'Sample Admin',
        decidedAt: at(30),
        version: 2,
      });
      state.balances.push({
        tenantId: TENANT_IDS.hospital,
        batchId: batch.id,
        locationId,
        onHand: 0,
      });
      post(state, {
        tenantId: TENANT_IDS.hospital,
        batch,
        locationId,
        quantity: units,
        reason: 'opening',
        sourceId: adjustmentId,
        actorName: 'Sample Admin',
        at: at(30),
      });
    }
  }
  // At the pharmacy counter, for the prescription of the clinical mock (#100): paracetamol 500 mg
  // tablets in a batch expiring sooner and one later, an expired one never offered, another brand
  // of the same (a generic substitute), and cetirizine.
  for (const [id, drugId, batchNumber, expiryDays, units] of [
    ['bat_h_rx1', 'drg_h_2573', 'PCM24A', 120, 4],
    ['bat_h_rx2', 'drg_h_2573', 'PCM25B', 400, 100],
    ['bat_h_rx3', 'drg_h_2573', 'PCM23X', -10, 20],
    ['bat_h_rx4', 'drg_h_2574', 'PMD25C', 300, 30],
    ['bat_h_rx5', 'drg_h_0805', 'CTZ25A', 250, 50],
  ] as const) {
    const batch: Batch = {
      id,
      tenantId: TENANT_IDS.hospital,
      drugId,
      batchNumber,
      expiryDate: day(expiryDays),
      mrpMinor: 250,
    };
    state.batches.push(batch);
    post(state, {
      tenantId: TENANT_IDS.hospital,
      batch,
      locationId: 'loc_h_pharmacy',
      quantity: units,
      reason: 'opening',
      sourceId: `adj_h_${id}`,
      actorName: 'Sample Admin',
      at: at(30),
    });
  }
  // A Schedule H1 medicine at the counter, for counter sales and the drug register (#101).
  const h1 = mockDrugsOf(TENANT_IDS.hospital).find(
    (drug) => drug.schedule === 'h1' && drug.type === 'medicine' && !drug.archived,
  );
  if (h1) {
    const batch: Batch = {
      id: 'bat_h_rx6',
      tenantId: TENANT_IDS.hospital,
      drugId: h1.id,
      batchNumber: 'CFX25A',
      expiryDate: day(300),
      mrpMinor: 1800,
    };
    state.batches.push(batch);
    post(state, {
      tenantId: TENANT_IDS.hospital,
      batch,
      locationId: 'loc_h_pharmacy',
      quantity: 40,
      reason: 'opening',
      sourceId: 'adj_h_bat_h_rx6',
      actorName: 'Sample Admin',
      at: at(30),
    });
  }
  // Two waiting for a second person: a damaged strip and opening stock of a new batch.
  const first = stocked[1];
  const firstBatch = state.batches[2];
  if (first && firstBatch) {
    state.adjustments.push({
      ...adjustmentView(first, firstBatch, 'loc_h_store', 'Main store'),
      id: 'adj_h_pending_1',
      tenantId: TENANT_IDS.hospital,
      newBatch: false,
      quantity: -10,
      reason: 'damaged',
      note: 'Strips crushed in transit',
      onHand: 0,
      status: 'pending',
      requestedById: USER_IDS.storeKeeper,
      requestedByName: 'Sample Store Keeper',
      requestedAt: at(1),
      version: 1,
    });
  }
  const second = stocked[3];
  if (second) {
    state.adjustments.push({
      id: 'adj_h_pending_2',
      tenantId: TENANT_IDS.hospital,
      locationId: 'loc_h_store',
      locationName: 'Main store',
      item: itemName(second),
      batchNumber: 'NEW001',
      expiryDate: day(540),
      newBatch: true,
      mrpMinor: 5200,
      costMinor: 3800,
      quantity: 120,
      reason: 'opening',
      onHand: 0,
      status: 'pending',
      requestedById: USER_IDS.storeKeeper,
      requestedByName: 'Sample Store Keeper',
      requestedAt: at(0),
      version: 1,
    });
  }
  return state;
}

type State = ReturnType<typeof seed>;

function byName(a: Drug, b: Drug): number {
  const key = (drug: Drug) => [
    drug.genericName.toLowerCase(),
    (drug.brandName ?? '').toLowerCase(),
    drug.id,
  ];
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < x.length; i += 1) {
    const order = (x[i] ?? '') < (y[i] ?? '') ? -1 : (x[i] ?? '') > (y[i] ?? '') ? 1 : 0;
    if (order !== 0) return order;
  }
  return 0;
}

function itemName(drug: Drug): StockItemName {
  return {
    drugId: drug.id,
    type: drug.type,
    genericName: drug.genericName,
    ...(drug.brandName ? { brandName: drug.brandName } : {}),
    form: drug.form,
    ...(drug.strength ? { strength: drug.strength } : {}),
    ...(drug.unit ? { unit: drug.unit } : {}),
  };
}

function adjustmentView(drug: Drug, batch: Batch, locationId: string, locationName: string) {
  return {
    locationId,
    locationName,
    item: itemName(drug),
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    expiryDate: batch.expiryDate,
    ...(batch.mrpMinor === undefined ? {} : { mrpMinor: batch.mrpMinor }),
  };
}

/** Posts a change of stock: the ledger entry moves the balance, never below zero. */
function post(
  state: State,
  change: {
    tenantId: string;
    batch: Batch;
    locationId: string;
    quantity: number;
    reason: StockLedgerEntry['reason'];
    source?: StockLedgerEntry['source'];
    sourceId: string;
    actorName: string;
    at?: string;
  },
): boolean {
  let balance = state.balances.find(
    (each) => each.batchId === change.batch.id && each.locationId === change.locationId,
  );
  if ((balance?.onHand ?? 0) + change.quantity < 0) return false;
  if (!balance) {
    balance = {
      tenantId: change.tenantId,
      batchId: change.batch.id,
      locationId: change.locationId,
      onHand: 0,
    };
    state.balances.push(balance);
  }
  balance.onHand += change.quantity;
  state.counter += 1;
  const location = state.locations.find((each) => each.id === change.locationId);
  const drug = mockDrug(change.tenantId, change.batch.drugId);
  state.ledger.push({
    id: `led_${state.counter}`,
    at: change.at ?? new Date(Date.now() + state.counter).toISOString(),
    item: drug
      ? itemName(drug)
      : { drugId: change.batch.drugId, type: 'medicine', genericName: '', form: 'other' },
    batchId: change.batch.id,
    batchNumber: change.batch.batchNumber,
    expiryDate: change.batch.expiryDate,
    locationId: change.locationId,
    locationName: location?.name ?? '',
    quantity: change.quantity,
    balanceAfter: balance.onHand,
    source: change.source ?? 'adjustment',
    sourceId: change.sourceId,
    reason: change.reason,
    actorName: change.actorName,
  });
  return true;
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** A batch that may be given from a place (#100): in date, with stock there. */
export interface MockUsableBatch {
  batchId: string;
  drugId: string;
  batchNumber: string;
  expiryDate: string;
  onHand: number;
  mrpMinor?: number;
}

/**
 * For the pharmacy's mock, as `usableBatches` of the API: the batches of these items with stock
 * at the place, not expired at the hospital today, nearest expiry first.
 */
export function mockUsableBatches(
  tenantId: string,
  drugIds: string[],
  locationId: string,
): MockUsableBatch[] {
  const today = todayIn(mockTenantTimezone(tenantId));
  return state.balances
    .filter(
      (each) => each.tenantId === tenantId && each.locationId === locationId && each.onHand > 0,
    )
    .flatMap((balance) => {
      const batch = state.batches.find((each) => each.id === balance.batchId);
      return batch && drugIds.includes(batch.drugId) && batch.expiryDate >= today
        ? [
            {
              batchId: batch.id,
              drugId: batch.drugId,
              batchNumber: batch.batchNumber,
              expiryDate: batch.expiryDate,
              onHand: balance.onHand,
              ...(batch.mrpMinor === undefined ? {} : { mrpMinor: batch.mrpMinor }),
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        a.expiryDate.localeCompare(b.expiryDate) || a.batchNumber.localeCompare(b.batchNumber),
    );
}

/**
 * For the pharmacy's mock, as `stockOut` of the API: takes units of an item out at a place, all
 * or nothing. Gives the refusal's code, or the batches taken from.
 */
export function mockStockOut(
  tenantId: string,
  movement: {
    locationId: string;
    drugId: string;
    sourceId: string;
    actorName: string;
    /** A dispense when not said; a counter sale (#101); goods sent back to a supplier (#103). */
    source?: 'dispense' | 'sale' | 'purchase_return';
    lines: { batchId: string; quantity: number }[];
    /** Expired units may go: only back to the supplier. */
    expiredAllowed?: boolean;
    /** Checks only, moving nothing: for a movement of several items, all or nothing. */
    dryRun?: boolean;
  },
):
  | { refused: string }
  | {
      locationName: string;
      batches: { batchId: string; batchNumber: string; expiryDate: string; quantity: number }[];
    } {
  const location = state.locations.find(
    (each) => each.id === movement.locationId && each.tenantId === tenantId && !each.archived,
  );
  if (!location) return { refused: 'unknown_location' };
  const today = todayIn(mockTenantTimezone(tenantId));
  const batches: Batch[] = [];
  for (const line of movement.lines) {
    const batch = state.batches.find(
      (each) =>
        each.id === line.batchId && each.tenantId === tenantId && each.drugId === movement.drugId,
    );
    if (!batch) return { refused: 'unknown_batch' };
    if (batch.expiryDate < today && !movement.expiredAllowed) return { refused: 'batch_expired' };
    if (onHandAt(batch.id, movement.locationId) < line.quantity)
      return { refused: 'insufficient_stock' };
    batches.push(batch);
  }
  if (movement.dryRun) return { locationName: location.name, batches: [] };
  return {
    locationName: location.name,
    batches: movement.lines.map((line, index) => {
      const batch = batches[index] as Batch;
      post(state, {
        tenantId,
        batch,
        locationId: movement.locationId,
        quantity: -line.quantity,
        reason: movement.source ?? 'dispense',
        source: movement.source ?? 'dispense',
        sourceId: movement.sourceId,
        actorName: movement.actorName,
      });
      return {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity: line.quantity,
      };
    }),
  };
}

/**
 * For the pharmacy's mock, as `stockIn` of the API: puts units of a sale's batches back at the
 * place, all or nothing (#101). Gives the refusal's code, or nothing.
 */
export function mockStockIn(
  tenantId: string,
  movement: {
    locationId: string;
    /** A sale's return (the default) or a dispense's (#104), whose wasted lines go out again. */
    source?: 'sale_return' | 'dispense_return';
    sourceId: string;
    actorName: string;
    lines: { batchId: string; quantity: number; wasted?: boolean }[];
  },
): { refused: string } | null {
  const location = state.locations.find(
    (each) => each.id === movement.locationId && each.tenantId === tenantId && !each.archived,
  );
  if (!location) return { refused: 'unknown_location' };
  const today = todayIn(mockTenantTimezone(tenantId));
  const batches: Batch[] = [];
  for (const line of movement.lines) {
    const batch = state.batches.find(
      (each) => each.id === line.batchId && each.tenantId === tenantId,
    );
    if (!batch) return { refused: 'unknown_batch' };
    if (batch.expiryDate < today && !line.wasted) return { refused: 'batch_expired' };
    batches.push(batch);
  }
  const source = movement.source ?? 'sale_return';
  movement.lines.forEach((line, index) => {
    const change = {
      tenantId,
      batch: batches[index] as Batch,
      locationId: movement.locationId,
      source,
      sourceId: movement.sourceId,
      actorName: movement.actorName,
    };
    post(state, { ...change, quantity: line.quantity, reason: source });
    // Wasted units are brought back and destroyed: in, then out again.
    if (line.wasted) post(state, { ...change, quantity: -line.quantity, reason: 'wastage' });
  });
  return null;
}

/** For purchasing's mock (#103): a place of the hospital in use, or null. */
export function mockPlaceInUse(tenantId: string, locationId: string) {
  const location = state.locations.find(
    (each) => each.id === locationId && each.tenantId === tenantId && !each.archived,
  );
  return location ? { id: location.id, name: location.name } : null;
}

/**
 * For purchasing's mock, as `stockReceive` of the API (#103): brings goods received into stock at
 * a place, each line a batch made when the item has no batch of that number (whatever the
 * capitals), found when it has one of the same expiry, all or nothing. Gives the refusal's code,
 * or each line's batch.
 */
export function mockStockReceive(
  tenantId: string,
  movement: {
    locationId: string;
    drugId: string;
    sourceId: string;
    actorName: string;
    lines: {
      batchNumber: string;
      expiryDate: string;
      mrpMinor?: number;
      quantity: number;
    }[];
    /** Checks only, moving nothing: for a receipt of several items, all or nothing. */
    dryRun?: boolean;
  },
):
  { refused: string } | { batches: { batchId: string; batchNumber: string; mrpMinor?: number }[] } {
  if (!mockPlaceInUse(tenantId, movement.locationId)) return { refused: 'unknown_location' };
  const today = todayIn(mockTenantTimezone(tenantId));
  const found: (Batch | null)[] = [];
  for (const line of movement.lines) {
    if (line.expiryDate < today) return { refused: 'batch_expired' };
    const batch =
      state.batches.find(
        (each) =>
          each.tenantId === tenantId &&
          each.drugId === movement.drugId &&
          each.batchNumber.toUpperCase() === line.batchNumber.toUpperCase(),
      ) ?? null;
    if (batch && batch.expiryDate !== line.expiryDate) return { refused: 'batch_exists' };
    found.push(batch);
  }
  if (movement.dryRun) return { batches: [] };
  return {
    batches: movement.lines.map((line, index) => {
      let batch = found[index] ?? null;
      if (!batch) {
        state.counter += 1;
        batch = {
          id: `bat_rcv_${state.counter}`,
          tenantId,
          drugId: movement.drugId,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          ...(line.mrpMinor === undefined ? {} : { mrpMinor: line.mrpMinor }),
        };
        state.batches.push(batch);
      }
      post(state, {
        tenantId,
        batch,
        locationId: movement.locationId,
        quantity: line.quantity,
        reason: 'receipt',
        source: 'receipt',
        sourceId: movement.sourceId,
        actorName: movement.actorName,
      });
      // The batch as it is: one already there keeps its own number and price.
      return {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        ...(batch.mrpMinor === undefined ? {} : { mrpMinor: batch.mrpMinor }),
      };
    }),
  };
}

/** For the pharmacy's mock: an item's ledger at the hospital, the oldest first (#101). */
export const mockLedgerOf = (tenantId: string, drugId: string) =>
  state.ledger
    .filter((entry) => entry.item.drugId === drugId && mockBatchTenant(entry.batchId) === tenantId)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

const mockBatchTenant = (batchId: string) =>
  state.batches.find((each) => each.id === batchId)?.tenantId;

/** For tests: the mock's adjustments and ledger as they are now. */
export const mockStock = () => ({ adjustments: state.adjustments, ledger: state.ledger });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const callerOf = () => currentSession()?.user ?? { id: '', name: '' };
const invalid = (message = 'The request is not valid') => error(400, 'validation_failed', message);
const conflict = () => error(409, 'conflict', 'It has changed since it was read');

const onHandAt = (batchId: string, locationId: string) =>
  state.balances.find((each) => each.batchId === batchId && each.locationId === locationId)
    ?.onHand ?? 0;

function viewOf(adjustment: Adjustment): StockAdjustment {
  const onHand = adjustment.batchId ? onHandAt(adjustment.batchId, adjustment.locationId) : 0;
  return { ...adjustment, onHand };
}

/** A page of a sorted list, by position: the cursor is the last row's id. */
function page<Row>(rows: Row[], idOf: (row: Row) => string, url: URL, withTotal = true) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
  const cursor = url.searchParams.get('cursor');
  let start = 0;
  if (cursor) {
    const index = rows.findIndex((row) => idOf(row) === cursor);
    if (index < 0) return null;
    start = index + 1;
  }
  const items = rows.slice(start, start + limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: start + limit < rows.length && last ? idOf(last) : null,
    ...(withTotal && !cursor ? { total: rows.length } : {}),
  };
}

/** The idempotency key of a POST, per hospital and user: a repeat answers as the first did. */
async function idempotent(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : null;
  const keyOf = key ? `${tenantId}:${callerOf().id}:${new URL(request.url).pathname}:${key}` : null;
  const earlier = keyOf ? state.answered.get(keyOf) : undefined;
  if (earlier && earlier.body !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    } as const;
  }
  const answer = (reply: unknown, status = 200) => {
    if (keyOf) state.answered.set(keyOf, { body: JSON.stringify(body), reply, status });
    return HttpResponse.json(reply as Record<string, unknown>, { status });
  };
  return {
    body,
    answer,
    replay: earlier
      ? HttpResponse.json(earlier.reply as Record<string, unknown>, { status: earlier.status })
      : null,
  } as const;
}

const expiryOf = (expiryDate: string, today: string, days: number): StockBatchBalance['expiry'] => {
  if (expiryDate < today) return 'expired';
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return expiryDate <= limit ? 'expiring' : 'ok';
};

function stockOf(tenantId: string, drug: Drug, locationId: string | null, days: number): StockItem {
  const today = todayIn(mockTenantTimezone(tenantId));
  const balances = state.balances.filter((balance) => {
    const batch = state.batches.find((each) => each.id === balance.batchId);
    return batch?.drugId === drug.id && balance.tenantId === tenantId;
  });
  const hospitalOnHand = balances.reduce((sum, each) => sum + each.onHand, 0);
  const here = balances.filter((each) => locationId === null || each.locationId === locationId);
  const batches = here
    .filter((each) => each.onHand > 0)
    .map((balance): StockBatchBalance => {
      const batch = state.batches.find((each) => each.id === balance.batchId) as Batch;
      return {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        ...(batch.mrpMinor === undefined ? {} : { mrpMinor: batch.mrpMinor }),
        locationId: balance.locationId,
        locationName: state.locations.find((each) => each.id === balance.locationId)?.name ?? '',
        onHand: balance.onHand,
        expiry: expiryOf(batch.expiryDate, today, days),
      };
    })
    .sort(
      (a, b) =>
        a.expiryDate.localeCompare(b.expiryDate) || a.batchNumber.localeCompare(b.batchNumber),
    );
  return {
    item: itemName(drug),
    ...(drug.reorderLevel === undefined || drug.reorderLevel === null
      ? {}
      : { reorderLevel: drug.reorderLevel }),
    onHand: here.reduce((sum, each) => sum + each.onHand, 0),
    hospitalOnHand,
    low: typeof drug.reorderLevel === 'number' && hospitalOnHand <= drug.reorderLevel,
    batches,
  };
}

const ALERTS = ['low', 'expiring', 'expired'] as const;

/** Whether a value is a YYYY-MM-DD day of the calendar, as the API's `realDay`. */
function realDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
const matches = (item: StockItem, alert: string | null) =>
  alert === null ||
  (alert === 'low' && item.low) ||
  ((alert === 'expiring' || alert === 'expired') && item.batches.some((b) => b.expiry === alert));

function daysOf(url: URL): number | null {
  const sent = url.searchParams.get('expiringWithinDays');
  if (sent === null) return EXPIRING_DAYS;
  const days = Number(sent);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
}

export const inventoryHandlers = [
  http.get('*/api/inventory/locations', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const archived = url.searchParams.get('archived') === 'true';
    const rows = state.locations
      .filter((each) => each.tenantId === access.tenantId && each.archived === archived)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const result = page(rows, (row) => row.id, url);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.post('*/api/inventory/locations', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) return sent.replay;
    const body = sent.body;
    const name =
      isObject(body) && typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
    if (!isObject(body) || !name || !KINDS.includes(body.kind as StockLocation['kind']))
      return invalid();
    const taken = state.locations.some(
      (each) => each.tenantId === access.tenantId && each.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) return error(409, 'location_name_taken', 'The hospital has a place of that name');
    state.counter += 1;
    const location: StockLocation = {
      id: `loc_new_${state.counter}`,
      tenantId: access.tenantId,
      name,
      kind: body.kind as StockLocation['kind'],
      archived: false,
      version: 1,
    };
    state.locations.push(location);
    return sent.answer(location, 201);
  }),

  http.patch('*/api/inventory/locations/:locationId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body: unknown = await request.json().catch(() => null);
    const location = state.locations.find(
      (each) => each.id === params.locationId && each.tenantId === access.tenantId,
    );
    if (!location) return error(404, 'location_not_found', 'No such place');
    if (!isObject(body) || body.expectedVersion !== location.version) return conflict();
    const name =
      typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : location.name;
    if (!name) return invalid();
    const kind = KINDS.includes(body.kind as StockLocation['kind'])
      ? (body.kind as StockLocation['kind'])
      : location.kind;
    const taken = state.locations.some(
      (each) =>
        each.tenantId === access.tenantId &&
        each.id !== location.id &&
        each.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) return error(409, 'location_name_taken', 'The hospital has a place of that name');
    if (name !== location.name || kind !== location.kind) {
      Object.assign(location, { name, kind, version: location.version + 1 });
    }
    return HttpResponse.json(location);
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/inventory/locations/:locationId/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const location = state.locations.find(
        (each) => each.id === params.locationId && each.tenantId === access.tenantId,
      );
      if (!location) return error(404, 'location_not_found', 'No such place');
      const archive = action === 'archive';
      if (location.archived !== archive) {
        if (
          archive &&
          state.balances.some((each) => each.locationId === location.id && each.onHand > 0)
        ) {
          return error(409, 'location_has_stock', 'A batch has stock at this place');
        }
        Object.assign(location, { archived: archive, version: location.version + 1 });
      }
      return HttpResponse.json(location);
    }),
  ),

  http.get('*/api/inventory/stock', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const days = daysOf(url);
    const alert = url.searchParams.get('alert');
    if (days === null || (alert !== null && !(ALERTS as readonly string[]).includes(alert))) {
      return invalid();
    }
    const locationId = url.searchParams.get('locationId');
    const drugId = url.searchParams.get('drugId');
    const items = [...mockDrugsOf(access.tenantId)]
      .sort(byName)
      .filter((drug) => drugId === null || drug.id === drugId)
      .map((drug) => stockOf(access.tenantId, drug, locationId, days))
      .filter((item) => matches(item, alert));
    const result = page(items, (row) => row.item.drugId, url);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.get('*/api/inventory/stock/alerts', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const days = daysOf(url);
    if (days === null) return invalid();
    const items = mockDrugsOf(access.tenantId).map((drug) =>
      stockOf(access.tenantId, drug, url.searchParams.get('locationId'), days),
    );
    return HttpResponse.json({
      low: items.filter((item) => matches(item, 'low')).length,
      expiring: items.filter((item) => matches(item, 'expiring')).length,
      expired: items.filter((item) => matches(item, 'expired')).length,
    });
  }),

  http.get('*/api/inventory/ledger', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const want = (name: string) => url.searchParams.get(name);
    const from = want('from');
    const to = want('to');
    const tenantBatches = new Set(
      state.batches.filter((each) => each.tenantId === access.tenantId).map((each) => each.id),
    );
    const rows = state.ledger
      .filter(
        (entry) =>
          tenantBatches.has(entry.batchId) &&
          (want('drugId') === null || entry.item.drugId === want('drugId')) &&
          (want('batchId') === null || entry.batchId === want('batchId')) &&
          (want('locationId') === null || entry.locationId === want('locationId')) &&
          (from === null || entry.at >= from) &&
          (to === null || entry.at < to),
      )
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const result = page(rows, (row) => row.id, url, false);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.get('*/api/inventory/adjustments', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const status = (url.searchParams.get('status') ?? 'pending') as Status;
    const rows = state.adjustments
      .filter((each) => each.tenantId === access.tenantId && each.status === status)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id))
      .map(viewOf);
    const result = page(rows, (row) => row.id, url);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.post('*/api/inventory/adjustments', async ({ request }) => {
    const access = authorize(request, { permission: ADJUST, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) return sent.replay;
    const body = sent.body;
    if (!isObject(body)) return invalid();
    const location = state.locations.find(
      (each) => each.id === body.locationId && each.tenantId === access.tenantId && !each.archived,
    );
    const drug = mockDrug(access.tenantId, String(body.drugId));
    const quantity = body.quantity;
    const reason = body.reason as Reason;
    if (!location || !drug || drug.archived || !REASONS.includes(reason)) return invalid();
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity === 0)
      return invalid();
    if (reason === 'opening' && quantity < 0) return invalid();
    if ((reason === 'damaged' || reason === 'expired') && quantity > 0) return invalid();
    const caller = callerOf();
    state.counter += 1;
    const base = {
      id: `adj_new_${state.counter}`,
      tenantId: access.tenantId,
      locationId: location.id,
      locationName: location.name,
      item: itemName(drug),
      quantity,
      reason,
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      onHand: 0,
      status: 'pending' as const,
      requestedById: caller.id,
      requestedByName: caller.name,
      requestedAt: new Date(Date.now() + state.counter).toISOString(),
      version: 1,
    };
    let adjustment: Adjustment;
    if (typeof body.batchId === 'string') {
      const batch = state.batches.find(
        (each) =>
          each.id === body.batchId && each.drugId === drug.id && each.tenantId === access.tenantId,
      );
      // A batch named, or one described: never both, as the API.
      const describes = ['batchNumber', 'expiryDate', 'mrpMinor', 'costMinor'].some(
        (field) => body[field] !== undefined,
      );
      if (!batch || describes) return invalid();
      if (quantity < 0 && onHandAt(batch.id, location.id) < -quantity) {
        return error(409, 'insufficient_stock', 'The batch has fewer units at the place than that');
      }
      adjustment = {
        ...base,
        ...adjustmentView(drug, batch, location.id, location.name),
        newBatch: false,
      };
    } else {
      const batchNumber = typeof body.batchNumber === 'string' ? body.batchNumber.trim() : '';
      if (reason !== 'opening' || !batchNumber || !realDay(body.expiryDate)) return invalid();
      const exists = state.batches.some(
        (each) =>
          each.drugId === drug.id && each.batchNumber.toUpperCase() === batchNumber.toUpperCase(),
      );
      if (exists) return error(409, 'batch_exists', 'The item has a batch of that number');
      adjustment = {
        ...base,
        batchNumber,
        expiryDate: body.expiryDate,
        newBatch: true,
        ...(typeof body.mrpMinor === 'number' ? { mrpMinor: body.mrpMinor } : {}),
        ...(typeof body.costMinor === 'number' ? { costMinor: body.costMinor } : {}),
      };
    }
    state.adjustments.push(adjustment);
    return sent.answer(viewOf(adjustment), 201);
  }),

  ...(['approve', 'reject'] as const).map((action) =>
    http.post(
      `*/api/inventory/adjustments/:adjustmentId/${action}`,
      async ({ request, params }) => {
        const access = authorize(request, { permission: APPROVE, featureFlag: FEATURE_FLAG });
        if ('denied' in access) return access.denied;
        const sent = await idempotent(request, access.tenantId);
        if ('refused' in sent) return sent.refused;
        if (sent.replay) return sent.replay;
        const body = sent.body;
        const adjustment = state.adjustments.find(
          (each) => each.id === params.adjustmentId && each.tenantId === access.tenantId,
        );
        if (!adjustment) return error(404, 'adjustment_not_found', 'No such adjustment');
        if (!isObject(body)) return invalid();
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (action === 'reject' && !note) return invalid('Say why it is rejected');
        if (adjustment.status !== 'pending') {
          return error(409, 'adjustment_decided', 'The adjustment was decided already');
        }
        if (body.expectedVersion !== adjustment.version) return conflict();
        const caller = callerOf();
        if (adjustment.requestedById === caller.id) {
          return error(409, 'own_adjustment', 'Someone else decides an adjustment you asked for');
        }
        if (action === 'approve') {
          const location = state.locations.find((each) => each.id === adjustment.locationId);
          if (!location || location.archived) {
            return error(409, 'location_archived', 'The place was archived');
          }
          const item = mockDrug(access.tenantId, adjustment.item.drugId);
          if (!item || item.archived) return error(409, 'item_archived', 'The item was archived');
          // A batch of that number made meanwhile is taken when its expiry is the same, as the API.
          let batch =
            state.batches.find((each) => each.id === adjustment.batchId) ??
            state.batches.find(
              (each) =>
                each.tenantId === access.tenantId &&
                each.drugId === adjustment.item.drugId &&
                each.batchNumber.toUpperCase() === adjustment.batchNumber.toUpperCase(),
            );
          if (batch && batch.expiryDate !== adjustment.expiryDate) {
            return error(409, 'batch_exists', 'A batch of that number has another expiry');
          }
          if (!batch) {
            state.counter += 1;
            batch = {
              id: `bat_new_${state.counter}`,
              tenantId: access.tenantId,
              drugId: adjustment.item.drugId,
              batchNumber: adjustment.batchNumber,
              expiryDate: adjustment.expiryDate,
              ...(adjustment.mrpMinor === undefined ? {} : { mrpMinor: adjustment.mrpMinor }),
            };
            state.batches.push(batch);
          }
          const posted = post(state, {
            tenantId: access.tenantId,
            batch,
            locationId: adjustment.locationId,
            quantity: adjustment.quantity,
            reason: adjustment.reason,
            sourceId: adjustment.id,
            actorName: caller.name,
          });
          if (!posted) {
            return error(
              409,
              'insufficient_stock',
              'The batch has fewer units at the place than that',
            );
          }
          adjustment.batchId = batch.id;
        }
        Object.assign(adjustment, {
          status: action === 'approve' ? 'approved' : 'rejected',
          decidedByName: caller.name,
          decidedAt: new Date().toISOString(),
          version: adjustment.version + 1,
          ...(action === 'reject' ? { rejectionNote: note } : {}),
        });
        return sent.answer(viewOf(adjustment));
      },
    ),
  ),
];
