import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS, USER_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDrug, mockDrugsOf } from './drugs';
import { mockPlaceInUse, mockStockOut, mockStockReceive } from './inventory';

type Drug = components['schemas']['Drug'];
type Supplier = components['schemas']['Supplier'];
type PurchaseOrder = components['schemas']['PurchaseOrder'];
type PurchaseOrderStatus = components['schemas']['PurchaseOrderStatus'];
type GoodsReceipt = components['schemas']['GoodsReceipt'];
type PurchaseReturn = components['schemas']['PurchaseReturn'];

const FEATURE_FLAG = 'purchasing';
const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;
const RETURN_REASONS = ['expired', 'damaged', 'wrong_item', 'other'];
const ORDER_STATUSES: readonly PurchaseOrderStatus[] = [
  'draft',
  'submitted',
  'approved',
  'partly_received',
  'received',
  'closed',
  'cancelled',
];

const reference = (prefix: string, number: number) =>
  `${prefix}-${String(number).padStart(6, '0')}`;
const nameOf = (drug: Drug) =>
  `${drug.genericName}${drug.strength ? ` ${drug.strength}` : ''}${drug.brandName ? ` (${drug.brandName})` : ''}`;

/**
 * Purchasing (#103), as the API: suppliers, orders submitted by one person and approved by
 * another, goods received into stock through the inventory mock (`mockStockReceive`) and sent back
 * (`mockStockOut` with the source `purchase_return`, expired units allowed). At the hospital: two
 * suppliers, and orders drafted and submitted by the store keeper: `po_h_draft` (a draft),
 * `po_h_submitted` (waiting for the admin), `po_h_approved` (approved by the admin, nothing
 * received) and `po_h_cancelled`. The clinic has purchasing off.
 */
function seed() {
  const state = {
    suppliers: [] as Supplier[],
    orders: [] as PurchaseOrder[],
    receipts: [] as GoodsReceipt[],
    returns: [] as PurchaseReturn[],
    numbers: new Map<string, number>(),
    answered: new Map<string, { body: string; reply: unknown; status: number }>(),
    counter: 0,
  };
  const tenantId = TENANT_IDS.hospital;
  state.suppliers.push(
    {
      id: 'sup_h_sunrise',
      tenantId,
      name: 'Sunrise Pharma Distributors',
      gstin: '27AABCS1234F1Z5',
      drugLicence: 'MH-MZ1-123456',
      phone: '+91 22 4000 1000',
      archived: false,
      version: 1,
    },
    {
      id: 'sup_h_medline',
      tenantId,
      name: 'Medline Surgical Supplies',
      gstin: '27AACCM5678G1Z2',
      phone: '+91 22 4000 2000',
      archived: false,
      version: 1,
    },
  );
  const drugs = mockDrugsOf(tenantId).slice(0, 4);
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const steps: [string, PurchaseOrderStatus][] = [
    ['po_h_draft', 'draft'],
    ['po_h_submitted', 'submitted'],
    ['po_h_approved', 'approved'],
    ['po_h_cancelled', 'cancelled'],
  ];
  steps.forEach(([id, status], index) => {
    const number = index + 1;
    const lines = drugs.slice(index % 2, (index % 2) + 2).map((drug, position) => ({
      id: `${id}_line_${position + 1}`,
      lineNumber: position + 1,
      drugId: drug.id,
      itemName: nameOf(drug),
      ...(drug.unit ? { unit: drug.unit } : {}),
      quantity: 200,
      unitCostMinor: 2800 + position * 500,
      receivedQuantity: 0,
    }));
    const submitted = status !== 'draft';
    state.orders.push({
      id,
      tenantId,
      reference: reference('PO', number),
      supplierId: index % 2 === 0 ? 'sup_h_sunrise' : 'sup_h_medline',
      supplierName: index % 2 === 0 ? 'Sunrise Pharma Distributors' : 'Medline Surgical Supplies',
      locationId: 'loc_h_store',
      locationName: 'Main store',
      status,
      totalMinor: lines.reduce((sum, line) => sum + line.quantity * line.unitCostMinor, 0),
      createdById: USER_IDS.storeKeeper,
      createdByName: 'Sample Store Keeper',
      createdAt: at(48 - index),
      editedById: USER_IDS.storeKeeper,
      ...(submitted
        ? {
            submittedById: USER_IDS.storeKeeper,
            submittedByName: 'Sample Store Keeper',
            submittedAt: at(40 - index),
          }
        : {}),
      ...(status === 'approved' ? { approvedByName: 'Sample Admin', approvedAt: at(30) } : {}),
      ...(status === 'cancelled'
        ? {
            endedByName: 'Sample Admin',
            endedAt: at(20),
            endNote: 'Supplier could not deliver this month',
          }
        : {}),
      lines,
      version: 1,
    });
  });
  state.numbers.set(`${tenantId}:order`, steps.length);
  return state;
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** For tests: purchasing as the mock holds it now. */
export const mockPurchasing = () => ({
  suppliers: state.suppliers,
  orders: state.orders,
  receipts: state.receipts,
  returns: state.returns,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const callerOf = () => currentSession()?.user ?? { id: '', name: '' };
const invalid = (message = 'The request is not valid') => error(400, 'validation_failed', message);
const conflict = () => error(409, 'conflict', 'It has changed since it was read');
const wrongStatus = () =>
  error(409, 'order_status', 'The order is not at a step where that can be done');
const text = (value: unknown, max: number): string | null | false => {
  if (value === undefined) return null;
  if (typeof value !== 'string') return false;
  const tidied = value.trim().replace(/\s+/g, ' ');
  return tidied.length > max ? false : tidied === '' ? null : tidied;
};
const whole = (value: unknown, max = 1_000_000): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
const money = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function nextNumber(tenantId: string, kind: string) {
  const key = `${tenantId}:${kind}`;
  const number = (state.numbers.get(key) ?? 0) + 1;
  state.numbers.set(key, number);
  return number;
}

/** A page of a sorted list, by position: the cursor is the last row's id. */
function page<Row>(rows: Row[], idOf: (row: Row) => string, url: URL) {
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
    ...(!cursor ? { total: rows.length } : {}),
  };
}

/** Every permission named, with purchasing switched on. */
function allowed(request: Request, permissions: string[]) {
  let last: ReturnType<typeof authorize> | undefined;
  for (const permission of permissions) {
    last = authorize(request, { permission, featureFlag: FEATURE_FLAG });
    if ('denied' in last) return last;
  }
  return last as { tenantId: string };
}

/** The idempotency key of a POST, per hospital and user: a repeat answers as the first did. */
async function idempotent(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  const raw = await request.text();
  const body: unknown = raw ? JSON.parse(raw) : null;
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

const supplierOf = (tenantId: string, id: string) =>
  state.suppliers.find((each) => each.id === id && each.tenantId === tenantId);
const orderOf = (tenantId: string, id: string) =>
  state.orders.find((each) => each.id === id && each.tenantId === tenantId);
const receiptOf = (tenantId: string, id: string) =>
  state.receipts.find((each) => each.id === id && each.tenantId === tenantId);

const summaryOf = ({ lines, note: _note, ...order }: PurchaseOrder) => ({
  id: order.id,
  tenantId: order.tenantId,
  reference: order.reference,
  supplierId: order.supplierId,
  supplierName: order.supplierName,
  locationId: order.locationId,
  locationName: order.locationName,
  status: order.status,
  totalMinor: order.totalMinor,
  createdById: order.createdById,
  createdByName: order.createdByName,
  createdAt: order.createdAt,
  ...(order.submittedById ? { submittedById: order.submittedById } : {}),
  version: order.version,
  lineCount: lines.length,
});

const receiptSummaryOf = ({ lines, note: _note, ...receipt }: GoodsReceipt) => ({
  ...receipt,
  lineCount: lines.length,
});

/** The lines of an order as sent: each an item in use, once. Null when one is not. */
function linesOf(tenantId: string, value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) return null;
  const seen = new Set<string>();
  const lines: PurchaseOrder['lines'] = [];
  for (const [index, line] of value.entries()) {
    if (!isObject(line) || typeof line.drugId !== 'string') return null;
    const drug = mockDrug(tenantId, line.drugId);
    if (!drug || drug.archived || seen.has(drug.id)) return null;
    if (!whole(line.quantity) || !money(line.unitCostMinor)) return null;
    seen.add(drug.id);
    lines.push({
      id: `pol_${(state.counter += 1)}`,
      lineNumber: index + 1,
      drugId: drug.id,
      itemName: nameOf(drug),
      ...(drug.unit ? { unit: drug.unit } : {}),
      quantity: line.quantity,
      unitCostMinor: line.unitCostMinor,
      receivedQuantity: 0,
    });
  }
  return lines;
}

const totalOf = (lines: { quantity: number; unitCostMinor: number }[]) =>
  lines.reduce((sum, line) => sum + line.quantity * line.unitCostMinor, 0);

/** A supplier's fields as sent; false when one is not valid. */
function supplierFields(body: Record<string, unknown>) {
  const fields: Partial<
    Record<'gstin' | 'drugLicence' | 'phone' | 'email' | 'address', string | null>
  > = {};
  if (body.gstin !== undefined) {
    if (body.gstin !== null && (typeof body.gstin !== 'string' || !GSTIN.test(body.gstin))) {
      return false;
    }
    fields.gstin = body.gstin;
  }
  for (const [key, max] of [
    ['drugLicence', 60],
    ['phone', 20],
    ['email', 254],
    ['address', 300],
  ] as const) {
    if (body[key] === undefined) continue;
    if (body[key] === null) {
      fields[key] = null;
      continue;
    }
    const value = text(body[key], max);
    if (value === false) return false;
    fields[key] = value;
  }
  return fields;
}

function applySupplier(
  supplier: Supplier,
  fields: Exclude<ReturnType<typeof supplierFields>, false>,
) {
  for (const [key, value] of Object.entries(fields) as [keyof typeof fields, string | null][]) {
    if (value === null) delete supplier[key];
    else supplier[key] = value;
  }
}

const nameTaken = (tenantId: string, name: string, exceptId?: string) =>
  state.suppliers.some(
    (each) =>
      each.tenantId === tenantId &&
      each.id !== exceptId &&
      each.name.toLowerCase() === name.toLowerCase(),
  );

export const purchasingHandlers = [
  // --- suppliers -------------------------------------------------------------------------------
  http.get('*/purchasing/suppliers', ({ request }) => {
    const access = allowed(request, ['supplier:read']);
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const archived = url.searchParams.get('archived') === 'true';
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const rows = state.suppliers
      .filter(
        (each) =>
          each.tenantId === access.tenantId &&
          each.archived === archived &&
          (q === '' || each.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const result = page(rows, (row) => row.id, url);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.post('*/purchasing/suppliers', async ({ request }) => {
    const access = allowed(request, ['supplier:manage', 'supplier:read']);
    if ('denied' in access) return access.denied;
    const keyed = await idempotent(request, access.tenantId);
    if ('refused' in keyed) return keyed.refused;
    if (keyed.replay) return keyed.replay;
    const body = keyed.body;
    if (!isObject(body)) return invalid();
    const name = text(body.name, 120);
    const fields = supplierFields(body);
    if (!name || fields === false) return invalid();
    if (nameTaken(access.tenantId, name)) {
      return error(409, 'supplier_name_taken', 'The hospital has a supplier of that name');
    }
    const supplier: Supplier = {
      id: `sup_${(state.counter += 1)}`,
      tenantId: access.tenantId,
      name,
      archived: false,
      version: 1,
    };
    applySupplier(supplier, fields);
    state.suppliers.push(supplier);
    return keyed.answer(supplier, 201);
  }),

  http.patch('*/purchasing/suppliers/:supplierId', async ({ request, params }) => {
    const access = allowed(request, ['supplier:manage', 'supplier:read']);
    if ('denied' in access) return access.denied;
    const supplier = supplierOf(access.tenantId, String(params.supplierId));
    if (!supplier) return error(404, 'supplier_not_found', 'No such supplier');
    const body: unknown = await request.json();
    if (!isObject(body) || typeof body.expectedVersion !== 'number') return invalid();
    if (body.expectedVersion !== supplier.version) return conflict();
    const name = body.name === undefined ? supplier.name : text(body.name, 120);
    const fields = supplierFields(body);
    if (!name || fields === false) return invalid();
    if (name !== supplier.name && nameTaken(access.tenantId, name, supplier.id)) {
      return error(409, 'supplier_name_taken', 'The hospital has a supplier of that name');
    }
    supplier.name = name;
    applySupplier(supplier, fields);
    supplier.version += 1;
    return HttpResponse.json(supplier);
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/purchasing/suppliers/:supplierId/${action}`, ({ request, params }) => {
      const access = allowed(request, ['supplier:manage', 'supplier:read']);
      if ('denied' in access) return access.denied;
      const supplier = supplierOf(access.tenantId, String(params.supplierId));
      if (!supplier) return error(404, 'supplier_not_found', 'No such supplier');
      const archive = action === 'archive';
      if (supplier.archived !== archive) {
        const open = state.orders.some(
          (order) =>
            order.supplierId === supplier.id &&
            ['draft', 'submitted', 'approved', 'partly_received'].includes(order.status),
        );
        if (archive && open) {
          return error(409, 'supplier_has_open_orders', 'An order may still bring goods');
        }
        supplier.archived = archive;
        supplier.version += 1;
      }
      return HttpResponse.json(supplier);
    }),
  ),

  // --- purchase orders -------------------------------------------------------------------------
  http.get('*/purchasing/orders', ({ request }) => {
    const access = allowed(request, ['purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    if (status && !ORDER_STATUSES.includes(status as PurchaseOrderStatus)) return invalid();
    const rows = state.orders
      .filter((each) => each.tenantId === access.tenantId && (!status || each.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(summaryOf);
    const result = page(rows, (row) => row.id, url);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.get('*/purchasing/orders/:orderId', ({ request, params }) => {
    const access = allowed(request, ['purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const order = orderOf(access.tenantId, String(params.orderId));
    return order
      ? HttpResponse.json(order)
      : error(404, 'order_not_found', 'No such purchase order');
  }),

  http.post('*/purchasing/orders', async ({ request }) => {
    const access = allowed(request, ['purchaseOrder:create', 'purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const keyed = await idempotent(request, access.tenantId);
    if ('refused' in keyed) return keyed.refused;
    if (keyed.replay) return keyed.replay;
    const body = keyed.body;
    if (!isObject(body) || typeof body.supplierId !== 'string') return invalid();
    const supplier = supplierOf(access.tenantId, body.supplierId);
    const place = mockPlaceInUse(access.tenantId, String(body.locationId));
    const lines = linesOf(access.tenantId, body.lines);
    const note = text(body.note, 500);
    if (!supplier || supplier.archived || !place || !lines || note === false) return invalid();
    const caller = callerOf();
    const order: PurchaseOrder = {
      id: `po_${(state.counter += 1)}`,
      tenantId: access.tenantId,
      reference: reference('PO', nextNumber(access.tenantId, 'order')),
      supplierId: supplier.id,
      supplierName: supplier.name,
      locationId: place.id,
      locationName: place.name,
      status: 'draft',
      totalMinor: totalOf(lines),
      createdById: caller.id,
      createdByName: caller.name,
      editedById: caller.id,
      createdAt: new Date(Date.now() + state.counter).toISOString(),
      ...(note ? { note } : {}),
      lines,
      version: 1,
    };
    state.orders.push(order);
    return keyed.answer(order, 201);
  }),

  http.patch('*/purchasing/orders/:orderId', async ({ request, params }) => {
    const access = allowed(request, ['purchaseOrder:create', 'purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const order = orderOf(access.tenantId, String(params.orderId));
    if (!order) return error(404, 'order_not_found', 'No such purchase order');
    const body: unknown = await request.json();
    if (!isObject(body) || typeof body.expectedVersion !== 'number') return invalid();
    if (body.expectedVersion !== order.version) return conflict();
    if (order.status !== 'draft') return wrongStatus();
    if (body.supplierId !== undefined) {
      const supplier = supplierOf(access.tenantId, String(body.supplierId));
      if (!supplier || supplier.archived) return invalid();
      order.supplierId = supplier.id;
      order.supplierName = supplier.name;
    }
    if (body.locationId !== undefined) {
      const place = mockPlaceInUse(access.tenantId, String(body.locationId));
      if (!place) return invalid();
      order.locationId = place.id;
      order.locationName = place.name;
    }
    if (body.note !== undefined) {
      const note = body.note === null ? null : text(body.note, 500);
      if (note === false) return invalid();
      if (note) order.note = note;
      else delete order.note;
    }
    if (body.lines !== undefined) {
      const lines = linesOf(access.tenantId, body.lines);
      if (!lines) return invalid();
      order.lines = lines;
      order.totalMinor = totalOf(lines);
    }
    order.editedById = callerOf().id;
    order.version += 1;
    return HttpResponse.json(order);
  }),

  ...(['submit', 'approve', 'cancel', 'close'] as const).map((step) =>
    http.post(`*/purchasing/orders/:orderId/${step}`, async ({ request, params }) => {
      const access = allowed(request, [
        step === 'approve' ? 'purchaseOrder:approve' : 'purchaseOrder:create',
        'purchaseOrder:read',
      ]);
      if ('denied' in access) return access.denied;
      const keyed = await idempotent(request, access.tenantId);
      if ('refused' in keyed) return keyed.refused;
      if (keyed.replay) return keyed.replay;
      const body = keyed.body;
      const order = orderOf(access.tenantId, String(params.orderId));
      if (!order) return error(404, 'order_not_found', 'No such purchase order');
      if (!isObject(body) || typeof body.expectedVersion !== 'number') return invalid();
      const note = step === 'cancel' || step === 'close' ? text(body.note, 200) : null;
      if ((step === 'cancel' || step === 'close') && !note) return invalid('Say why');
      if (body.expectedVersion !== order.version) return conflict();
      const caller = callerOf();
      const now = new Date().toISOString();
      if (step === 'submit') {
        if (order.status !== 'draft') return wrongStatus();
        Object.assign(order, {
          status: 'submitted',
          submittedById: caller.id,
          submittedByName: caller.name,
          submittedAt: now,
        });
      } else if (step === 'approve') {
        if (order.status !== 'submitted') return wrongStatus();
        if ([order.submittedById, order.createdById, order.editedById].includes(caller.id)) {
          return error(409, 'own_order', 'Someone else approves an order you wrote or submitted');
        }
        if (supplierOf(access.tenantId, order.supplierId)?.archived) {
          return error(409, 'supplier_archived', 'The supplier was archived');
        }
        Object.assign(order, { status: 'approved', approvedByName: caller.name, approvedAt: now });
      } else {
        const from: PurchaseOrderStatus[] =
          step === 'cancel' ? ['draft', 'submitted', 'approved'] : ['partly_received'];
        if (!from.includes(order.status)) return wrongStatus();
        Object.assign(order, {
          status: step === 'cancel' ? 'cancelled' : 'closed',
          endedByName: caller.name,
          endedAt: now,
          endNote: note,
        });
      }
      order.version += 1;
      return keyed.answer(order);
    }),
  ),

  // --- goods receipts --------------------------------------------------------------------------
  http.get('*/purchasing/receipts', ({ request }) => {
    const access = allowed(request, ['purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const orderId = url.searchParams.get('orderId');
    const rows = state.receipts
      .filter((each) => each.tenantId === access.tenantId && (!orderId || each.orderId === orderId))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id))
      .map(receiptSummaryOf);
    const result = page(rows, (row) => row.id, url);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.get('*/purchasing/receipts/:receiptId', ({ request, params }) => {
    const access = allowed(request, ['purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const receipt = receiptOf(access.tenantId, String(params.receiptId));
    return receipt
      ? HttpResponse.json(receipt)
      : error(404, 'receipt_not_found', 'No such goods receipt');
  }),

  http.post('*/purchasing/orders/:orderId/receipts', async ({ request, params }) => {
    const access = allowed(request, ['goodsReceipt:create', 'purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const keyed = await idempotent(request, access.tenantId);
    if ('refused' in keyed) return keyed.refused;
    if (keyed.replay) return keyed.replay;
    const body = keyed.body;
    const order = orderOf(access.tenantId, String(params.orderId));
    if (!order) return error(404, 'order_not_found', 'No such purchase order');
    if (order.status !== 'approved' && order.status !== 'partly_received') return wrongStatus();
    if (!isObject(body) || !Array.isArray(body.lines) || body.lines.length === 0) return invalid();
    const place = mockPlaceInUse(access.tenantId, String(body.locationId ?? order.locationId));
    const invoice = text(body.supplierInvoice, 60);
    const note = text(body.note, 200);
    if (!place || invoice === false || note === false) return invalid();
    const coming = new Map<string, number>();
    const numbers = new Set<string>();
    const lines: {
      orderLine: PurchaseOrder['lines'][number];
      batchNumber: string;
      expiryDate: string;
      quantity: number;
      unitCostMinor: number;
      mrpMinor: number | undefined;
    }[] = [];
    for (const line of body.lines as unknown[]) {
      if (!isObject(line)) return invalid();
      const orderLine = order.lines.find((each) => each.id === line.orderLineId);
      const batchNumber = text(line.batchNumber, 40);
      if (!orderLine || !batchNumber || typeof line.expiryDate !== 'string') return invalid();
      if (!whole(line.quantity) || !money(line.unitCostMinor)) return invalid();
      if (line.mrpMinor !== undefined && !money(line.mrpMinor)) return invalid();
      if (line.unitCostMinor > orderLine.unitCostMinor) {
        return error(409, 'cost_above_order', 'A unit costs more than the agreed price');
      }
      const key = `${orderLine.drugId}:${batchNumber.toUpperCase()}`;
      if (numbers.has(key)) return invalid();
      numbers.add(key);
      coming.set(orderLine.id, (coming.get(orderLine.id) ?? 0) + line.quantity);
      lines.push({
        orderLine,
        batchNumber,
        expiryDate: line.expiryDate,
        quantity: line.quantity,
        unitCostMinor: line.unitCostMinor,
        mrpMinor: line.mrpMinor as number | undefined,
      });
    }
    for (const [orderLineId, quantity] of coming) {
      const orderLine = order.lines.find((each) => each.id === orderLineId);
      if (orderLine && orderLine.receivedQuantity + quantity > orderLine.quantity) {
        return error(409, 'over_receipt', 'More units than the order line still waits for');
      }
    }
    const caller = callerOf();
    const receiptId = `grn_${(state.counter += 1)}`;
    const received: GoodsReceipt['lines'] = [];
    const drugIds = [...new Set(lines.map((line) => line.orderLine.drugId))];
    if (drugIds.some((drugId) => mockDrug(access.tenantId, drugId)?.archived !== false)) {
      return error(409, 'item_archived', 'An item was archived since it was ordered');
    }
    // Every item checked before any moves, as the API's one transaction does.
    for (const dryRun of [true, false])
      for (const drugId of drugIds) {
        const ofItem = lines.filter((line) => line.orderLine.drugId === drugId);
        const moved = mockStockReceive(access.tenantId, {
          dryRun,
          locationId: place.id,
          drugId,
          sourceId: receiptId,
          actorName: caller.name,
          lines: ofItem.map((line) => ({
            batchNumber: line.batchNumber,
            expiryDate: line.expiryDate,
            quantity: line.quantity,
            ...(line.mrpMinor === undefined ? {} : { mrpMinor: line.mrpMinor }),
          })),
        });
        if ('refused' in moved) {
          return error(409, moved.refused, 'Refused by stock');
        }
        if (dryRun) continue;
        ofItem.forEach((line, index) => {
          const batch = moved.batches[index];
          received.push({
            id: `grl_${(state.counter += 1)}`,
            lineNumber: lines.indexOf(line) + 1,
            orderLineId: line.orderLine.id,
            drugId,
            itemName: line.orderLine.itemName,
            ...(line.orderLine.unit ? { unit: line.orderLine.unit } : {}),
            batchId: batch?.batchId ?? '',
            batchNumber: batch?.batchNumber ?? line.batchNumber,
            expiryDate: line.expiryDate,
            ...(batch?.mrpMinor === undefined ? {} : { mrpMinor: batch.mrpMinor }),
            quantity: line.quantity,
            unitCostMinor: line.unitCostMinor,
            returnedQuantity: 0,
          });
        });
      }
    received.sort((a, b) => a.lineNumber - b.lineNumber);
    for (const line of order.lines) line.receivedQuantity += coming.get(line.id) ?? 0;
    order.status = order.lines.every((line) => line.receivedQuantity >= line.quantity)
      ? 'received'
      : 'partly_received';
    order.version += 1;
    const receipt: GoodsReceipt = {
      id: receiptId,
      tenantId: access.tenantId,
      reference: reference('GRN', nextNumber(access.tenantId, 'receipt')),
      orderId: order.id,
      orderReference: order.reference,
      supplierId: order.supplierId,
      supplierName: order.supplierName,
      locationId: place.id,
      locationName: place.name,
      ...(invoice ? { supplierInvoice: invoice } : {}),
      ...(note ? { note } : {}),
      totalMinor: totalOf(received),
      receivedByName: caller.name,
      receivedAt: new Date(Date.now() + state.counter).toISOString(),
      lines: received,
    };
    state.receipts.push(receipt);
    return keyed.answer(receipt, 201);
  }),

  // --- returns to the supplier -----------------------------------------------------------------
  http.get('*/purchasing/returns', ({ request }) => {
    const access = allowed(request, ['purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const receiptId = url.searchParams.get('receiptId');
    const rows = state.returns
      .filter(
        (each) => each.tenantId === access.tenantId && (!receiptId || each.receiptId === receiptId),
      )
      .sort((a, b) => b.returnedAt.localeCompare(a.returnedAt) || b.id.localeCompare(a.id));
    const result = page(rows, (row) => row.id, url);
    return result ? HttpResponse.json(result) : error(400, 'invalid_cursor', 'Unknown cursor');
  }),

  http.post('*/purchasing/receipts/:receiptId/returns', async ({ request, params }) => {
    const access = allowed(request, ['purchaseReturn:create', 'purchaseOrder:read']);
    if ('denied' in access) return access.denied;
    const keyed = await idempotent(request, access.tenantId);
    if ('refused' in keyed) return keyed.refused;
    if (keyed.replay) return keyed.replay;
    const body = keyed.body;
    const receipt = receiptOf(access.tenantId, String(params.receiptId));
    if (!receipt) return error(404, 'receipt_not_found', 'No such goods receipt');
    if (!isObject(body) || !Array.isArray(body.lines) || body.lines.length === 0) return invalid();
    if (typeof body.reason !== 'string' || !RETURN_REASONS.includes(body.reason)) return invalid();
    const note = text(body.note, 200);
    if (note === false || (body.reason === 'other' && !note)) return invalid();
    const place = mockPlaceInUse(access.tenantId, String(body.locationId ?? receipt.locationId));
    if (!place) return invalid();
    const seen = new Set<string>();
    const lines: { receiptLine: GoodsReceipt['lines'][number]; quantity: number }[] = [];
    for (const line of body.lines as unknown[]) {
      if (!isObject(line) || !whole(line.quantity)) return invalid();
      const receiptLine = receipt.lines.find((each) => each.id === line.receiptLineId);
      if (!receiptLine || seen.has(receiptLine.id)) return invalid();
      seen.add(receiptLine.id);
      if (receiptLine.returnedQuantity + line.quantity > receiptLine.quantity) {
        return error(409, 'over_return', 'More units than the line brought in and kept');
      }
      lines.push({ receiptLine, quantity: line.quantity });
    }
    const caller = callerOf();
    const returnId = `prn_${(state.counter += 1)}`;
    // Every item checked before any moves, as the API's one transaction does.
    for (const dryRun of [true, false])
      for (const drugId of new Set(lines.map((line) => line.receiptLine.drugId))) {
        const ofItem = lines.filter((line) => line.receiptLine.drugId === drugId);
        const moved = mockStockOut(access.tenantId, {
          dryRun,
          locationId: place.id,
          drugId,
          sourceId: returnId,
          actorName: caller.name,
          source: 'purchase_return',
          expiredAllowed: true,
          lines: ofItem.map((line) => ({
            batchId: line.receiptLine.batchId,
            quantity: line.quantity,
          })),
        });
        if ('refused' in moved) return error(409, moved.refused, 'Refused by stock');
      }
    for (const line of lines) line.receiptLine.returnedQuantity += line.quantity;
    const back: PurchaseReturn = {
      id: returnId,
      tenantId: access.tenantId,
      reference: reference('PRN', nextNumber(access.tenantId, 'return')),
      receiptId: receipt.id,
      receiptReference: receipt.reference,
      supplierId: receipt.supplierId,
      supplierName: receipt.supplierName,
      locationId: place.id,
      locationName: place.name,
      reason: body.reason as PurchaseReturn['reason'],
      ...(note ? { note } : {}),
      lines: lines.map((line) => ({
        id: `prl_${(state.counter += 1)}`,
        receiptLineId: line.receiptLine.id,
        drugId: line.receiptLine.drugId,
        itemName: line.receiptLine.itemName,
        batchId: line.receiptLine.batchId,
        batchNumber: line.receiptLine.batchNumber,
        expiryDate: line.receiptLine.expiryDate,
        quantity: line.quantity,
        unitCostMinor: line.receiptLine.unitCostMinor,
      })),
      totalMinor: lines.reduce(
        (sum, line) => sum + line.quantity * line.receiptLine.unitCostMinor,
        0,
      ),
      returnedByName: caller.name,
      returnedAt: new Date(Date.now() + state.counter).toISOString(),
    };
    state.returns.push(back);
    return keyed.answer(back, 201);
  }),
];
