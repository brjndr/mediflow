import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { searchTerm, tidyLinesOptional, tidyOptional, tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { stockableDrug } from '../drugs/index.js';
import { placeInUse, stockOut, stockReceive } from '../inventory/index.js';
import {
  findOrder,
  findReceipt,
  findReturn,
  findSupplier,
  insertOrder,
  insertReceipt,
  insertReceiptLine,
  insertReturn,
  insertReturnLine,
  insertSupplier,
  isUuid,
  isViolation,
  listOrders,
  listReceipts,
  listReturns,
  listSuppliers,
  lockOrder,
  lockReceipt,
  lockSupplier,
  moveOrder,
  nextNumber,
  orderLines,
  receiptLines,
  replaceOrderLines,
  returnLines,
  supplierHasOpenOrder,
  supplierNameTaken,
  updateOrderFields,
  updateSupplier,
  type OrderLineRow,
  type OrderRow,
  type ReceiptLineRow,
  type ReceiptRow,
  type ReturnLineRow,
  type ReturnRow,
  type SupplierFields,
  type SupplierRow,
} from './repository.js';
import {
  ADDRESS_MAX,
  BATCH_NUMBER_MAX,
  DRUG_LICENCE_MAX,
  EMAIL_MAX,
  GoodsReceipt,
  GoodsReceiptCreate,
  GoodsReceiptListQuery,
  GoodsReceiptPage,
  INVOICE_MAX,
  NOTE_MAX,
  ORDER_NOTE_MAX,
  PHONE_MAX,
  PURCHASING_SCHEMAS,
  PurchaseOrder,
  PurchaseOrderCreate,
  PurchaseOrderEnd,
  PurchaseOrderListQuery,
  PurchaseOrderPage,
  PurchaseOrderStep,
  PurchaseOrderUpdate,
  PurchaseReturn,
  PurchaseReturnCreate,
  PurchaseReturnListQuery,
  PurchaseReturnPage,
  Supplier,
  SupplierCreate,
  SupplierListQuery,
  SupplierPage,
  SupplierUpdate,
  SUPPLIER_NAME_MAX,
  type GoodsReceiptLine,
  type GoodsReceiptSummary,
  type OrderStatus,
  type PurchaseOrderLine,
  type PurchaseOrderLineInput,
  type PurchaseOrderSummary,
} from './schemas.js';

export const FEATURE = 'purchasing';

const READ_SUPPLIERS = 'supplier:read';
const MANAGE_SUPPLIERS = 'supplier:manage';
const READ = 'purchaseOrder:read';
const CREATE = 'purchaseOrder:create';
const APPROVE = 'purchaseOrder:approve';
const RECEIVE = 'goodsReceipt:create';
const RETURN = 'purchaseReturn:create';

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const conflict = () => new HttpError(409, 'conflict', 'It has changed since it was read');
const badCursor = () => new HttpError(400, 'invalid_cursor', 'Unknown cursor');
const supplierGone = () => new HttpError(404, 'supplier_not_found', 'No such supplier');
const orderGone = () => new HttpError(404, 'order_not_found', 'No such purchase order');
const receiptGone = () => new HttpError(404, 'receipt_not_found', 'No such goods receipt');
const returnGone = () => new HttpError(404, 'return_not_found', 'No such return');
const nameTaken = () =>
  new HttpError(409, 'supplier_name_taken', 'The hospital has a supplier of that name');
const wrongStatus = () =>
  new HttpError(409, 'order_status', 'The order is not at a step where that can be done');

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

const reference = (prefix: 'PO' | 'GRN' | 'PRN', number: number) =>
  `${prefix}-${String(number).padStart(6, '0')}`;

/** Whether a calendar date sent as YYYY-MM-DD is a real day. */
function realDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const supplierView = (row: SupplierRow): Supplier => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  ...optional('gstin', row.gstin),
  ...optional('drugLicence', row.drug_licence),
  ...optional('phone', row.phone),
  ...optional('email', row.email),
  ...optional('address', row.address),
  archived: row.archived,
  version: row.version,
});

const orderSummaryView = (row: OrderRow): PurchaseOrderSummary => ({
  id: row.id,
  tenantId: row.tenant_id,
  reference: reference('PO', row.number),
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  locationId: row.location_id,
  locationName: row.location_name,
  status: row.status,
  totalMinor: Number(row.total_minor),
  lineCount: row.line_count,
  createdById: row.created_by,
  createdByName: row.created_by_name ?? '',
  createdAt: row.created_at.toISOString(),
  ...optional('submittedById', row.submitted_by),
  version: row.version,
});

const orderLineView = (row: OrderLineRow): PurchaseOrderLine => ({
  id: row.id,
  lineNumber: row.line_number,
  drugId: row.drug_id,
  itemName: row.item_name,
  ...optional('unit', row.unit),
  quantity: row.quantity,
  unitCostMinor: Number(row.unit_cost_minor),
  receivedQuantity: row.received_quantity,
});

const orderView = (row: OrderRow, lines: OrderLineRow[]): PurchaseOrder => {
  const { lineCount: _lineCount, ...summary } = orderSummaryView(row);
  return {
    ...summary,
    ...optional('note', row.note),
    lines: lines.map(orderLineView),
    editedById: row.edited_by,
    ...optional('submittedByName', row.submitted_by_name),
    ...optional('submittedAt', row.submitted_at?.toISOString()),
    ...optional('approvedByName', row.approved_by_name),
    ...optional('approvedAt', row.approved_at?.toISOString()),
    ...optional('endedByName', row.ended_by_name),
    ...optional('endedAt', row.ended_at?.toISOString()),
    ...optional('endNote', row.end_note),
  };
};

const receiptSummaryView = (row: ReceiptRow): GoodsReceiptSummary => ({
  id: row.id,
  tenantId: row.tenant_id,
  reference: reference('GRN', row.number),
  orderId: row.order_id,
  orderReference: reference('PO', row.order_number),
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  locationId: row.location_id,
  locationName: row.location_name,
  ...optional('supplierInvoice', row.supplier_invoice),
  totalMinor: Number(row.total_minor),
  lineCount: row.line_count,
  receivedByName: row.received_by_name ?? '',
  receivedAt: row.received_at.toISOString(),
});

const receiptLineView = (row: ReceiptLineRow): GoodsReceiptLine => ({
  id: row.id,
  lineNumber: row.line_number,
  orderLineId: row.order_line_id,
  drugId: row.drug_id,
  itemName: row.item_name,
  ...optional('unit', row.unit),
  batchId: row.batch_id,
  batchNumber: row.batch_number,
  expiryDate: row.expiry_date,
  ...optional('mrpMinor', row.mrp_minor === null ? null : Number(row.mrp_minor)),
  quantity: row.quantity,
  unitCostMinor: Number(row.unit_cost_minor),
  returnedQuantity: row.returned_quantity,
});

const receiptView = (row: ReceiptRow, lines: ReceiptLineRow[]): GoodsReceipt => {
  const { lineCount: _lineCount, ...summary } = receiptSummaryView(row);
  return { ...summary, ...optional('note', row.note), lines: lines.map(receiptLineView) };
};

const returnView = (row: ReturnRow, lines: ReturnLineRow[]): PurchaseReturn => {
  const own = lines.filter((line) => line.return_id === row.id);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    reference: reference('PRN', row.number),
    receiptId: row.receipt_id,
    receiptReference: reference('GRN', row.receipt_number),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    locationId: row.location_id,
    locationName: row.location_name,
    reason: row.reason,
    ...optional('note', row.note),
    lines: own.map((line) => ({
      id: line.id,
      receiptLineId: line.receipt_line_id,
      drugId: line.drug_id,
      itemName: line.item_name,
      batchId: line.batch_id,
      batchNumber: line.batch_number,
      expiryDate: line.expiry_date,
      quantity: line.quantity,
      unitCostMinor: Number(line.unit_cost_minor),
    })),
    totalMinor: own.reduce((sum, line) => sum + line.quantity * Number(line.unit_cost_minor), 0),
    returnedByName: row.returned_by_name ?? '',
    returnedAt: row.returned_at.toISOString(),
  };
};

/** A name as it is stored, and not empty once it is tidied. */
function cleanName(name: string): string {
  const tidied = tidyWithin(name, SUPPLIER_NAME_MAX);
  if (tidied === '') throw invalid('A name is required');
  return tidied;
}

/** An optional field of an edit: kept when not sent, cleared by null, else tidied. */
const edited = (
  value: string | null | undefined,
  current: string | null,
  tidyIt: (text: string) => string | null,
): string | null => (value === undefined ? current : value === null ? null : tidyIt(value));

export const purchasingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of PURCHASING_SCHEMAS) app.addSchema(schema);

  const SupplierParams = Type.Object({ supplierId: Type.String({ maxLength: 64 }) });
  const OrderParams = Type.Object({ orderId: Type.String({ maxLength: 64 }) });
  const ReceiptParams = Type.Object({ receiptId: Type.String({ maxLength: 64 }) });

  // --- suppliers -------------------------------------------------------------------------------

  app.get(
    '/purchasing/suppliers',
    {
      config: { permissions: [READ_SUPPLIERS], feature: FEATURE },
      schema: {
        operationId: 'listSuppliers',
        tags: ['purchasing'],
        description:
          'The suppliers of the active tenant in use (or archived), by name, of a name with `q` in it. `total` comes with the first page. A GET: a supplier says nothing about a patient.',
        querystring: SupplierListQuery,
        response: { 200: ref(SupplierPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, archived = false } = request.query;
      const q = searchTerm(request.query.q) ?? null;
      const list = await listSuppliers(request.txClient, {
        archived,
        q: q === '' ? null : q,
        cursor,
        limit,
      });
      if (!list) throw badCursor();
      return {
        items: list.rows.map(supplierView),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  app.get(
    '/purchasing/suppliers/:supplierId',
    {
      config: { permissions: [READ_SUPPLIERS], feature: FEATURE },
      schema: {
        operationId: 'getSupplier',
        tags: ['purchasing'],
        description: 'One supplier. Another hospital’s answers 404, as one that does not exist.',
        params: SupplierParams,
        response: { 200: ref(Supplier), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findSupplier(request.txClient, request.params.supplierId);
      if (!row) throw supplierGone();
      return supplierView(row);
    },
  );

  app.post(
    '/purchasing/suppliers',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: {
        permissions: [MANAGE_SUPPLIERS, READ_SUPPLIERS],
        feature: FEATURE,
        idempotent: { body: 'full' },
      },
      schema: {
        operationId: 'createSupplier',
        tags: ['purchasing'],
        headers: IdempotencyHeaders,
        description:
          'Adds a supplier. A name the hospital already has, archived or not, whatever the capitals, is 409 supplier_name_taken. Audited.',
        body: ref(SupplierCreate),
        response: { 201: ref(Supplier), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as SupplierCreate;
      const fields: SupplierFields = {
        name: cleanName(body.name),
        gstin: body.gstin ?? null,
        drugLicence: tidyOptional(body.drugLicence, DRUG_LICENCE_MAX),
        phone: tidyOptional(body.phone, PHONE_MAX),
        email: tidyOptional(body.email, EMAIL_MAX),
        address: tidyLinesOptional(body.address, ADDRESS_MAX),
      };
      if (await supplierNameTaken(request.txClient, fields.name)) throw nameTaken();
      let id: string;
      try {
        id = await insertSupplier(request.txClient, fields);
      } catch (error) {
        if (isViolation(error, 'suppliers_name_taken')) throw nameTaken();
        throw error;
      }
      request.audit('create', 'supplier', id);
      const row = await findSupplier(request.txClient, id);
      if (!row) throw supplierGone();
      return reply.status(201).send(supplierView(row));
    },
  );

  app.patch(
    '/purchasing/suppliers/:supplierId',
    {
      config: { permissions: [MANAGE_SUPPLIERS, READ_SUPPLIERS], feature: FEATURE },
      schema: {
        operationId: 'updateSupplier',
        tags: ['purchasing'],
        description:
          'Changes the fields sent; null clears an optional one. 409 conflict when it changed since the version sent; 409 supplier_name_taken as on adding. Sending what it has changes nothing. Audited.',
        params: SupplierParams,
        body: ref(SupplierUpdate),
        response: { 200: ref(Supplier), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as SupplierUpdate;
      const current = await lockSupplier(request.txClient, request.params.supplierId);
      if (!current) throw supplierGone();
      if (current.version !== body.expectedVersion) throw conflict();
      const fields: SupplierFields = {
        name: body.name === undefined ? current.name : cleanName(body.name),
        gstin: edited(body.gstin, current.gstin, (text) => text),
        drugLicence: edited(body.drugLicence, current.drug_licence, (text) =>
          tidyOptional(text, DRUG_LICENCE_MAX),
        ),
        phone: edited(body.phone, current.phone, (text) => tidyOptional(text, PHONE_MAX)),
        email: edited(body.email, current.email, (text) => tidyOptional(text, EMAIL_MAX)),
        address: edited(body.address, current.address, (text) =>
          tidyLinesOptional(text, ADDRESS_MAX),
        ),
      };
      if (
        fields.name !== current.name &&
        (await supplierNameTaken(request.txClient, fields.name, current.id))
      ) {
        throw nameTaken();
      }
      const changed =
        fields.name !== current.name ||
        fields.gstin !== current.gstin ||
        fields.drugLicence !== current.drug_licence ||
        fields.phone !== current.phone ||
        fields.email !== current.email ||
        fields.address !== current.address;
      if (changed) {
        try {
          await updateSupplier(request.txClient, current.id, {
            ...fields,
            archived: current.archived,
          });
        } catch (error) {
          if (isViolation(error, 'suppliers_name_taken')) throw nameTaken();
          throw error;
        }
        request.audit('update', 'supplier', current.id);
      }
      const row = await findSupplier(request.txClient, current.id);
      if (!row) throw supplierGone();
      return supplierView(row);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/purchasing/suppliers/:supplierId/${action}`,
      {
        config: { permissions: [MANAGE_SUPPLIERS, READ_SUPPLIERS], feature: FEATURE },
        schema: {
          operationId: `${action}Supplier`,
          tags: ['purchasing'],
          description:
            (action === 'archive'
              ? 'Archives a supplier: nothing more is ordered from it. Refused with 409 supplier_has_open_orders while an order of it may still bring goods.'
              : 'Brings an archived supplier back.') +
            ' Doing it twice changes nothing. Audited. Another hospital’s answers 404.',
          params: SupplierParams,
          response: { 200: ref(Supplier), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const archive = action === 'archive';
        // Held against an order made of it at the same moment (`for share` there).
        const current = await lockSupplier(request.txClient, request.params.supplierId);
        if (!current) throw supplierGone();
        if (current.archived !== archive) {
          if (archive && (await supplierHasOpenOrder(request.txClient, current.id))) {
            throw new HttpError(
              409,
              'supplier_has_open_orders',
              'An order of the supplier may still bring goods',
            );
          }
          await updateSupplier(request.txClient, current.id, {
            name: current.name,
            gstin: current.gstin,
            drugLicence: current.drug_licence,
            phone: current.phone,
            email: current.email,
            address: current.address,
            archived: archive,
          });
          request.audit(action, 'supplier', current.id);
        }
        const row = await findSupplier(request.txClient, current.id);
        if (!row) throw supplierGone();
        return supplierView(row);
      },
    );
  }

  // --- purchase orders -------------------------------------------------------------------------

  /** The supplier to order from: of the hospital and in use, held so it is not archived meanwhile. */
  async function supplierInUse(request: FastifyRequest, supplierId: string): Promise<SupplierRow> {
    const supplier = await lockSupplier(request.txClient, supplierId, 'share');
    if (!supplier || supplier.archived) {
      throw invalid('supplierId is not a supplier of this hospital that is in use');
    }
    return supplier;
  }

  async function place(request: FastifyRequest, locationId: string) {
    const found = await placeInUse(request.txClient, locationId);
    if (!found) throw invalid('locationId is not a place of this hospital that is in use');
    return found;
  }

  /** The lines of an order: each item in use, and once. */
  async function cleanLines(
    request: FastifyRequest,
    lines: PurchaseOrderLineInput[],
  ): Promise<PurchaseOrderLineInput[]> {
    const seen = new Set<string>();
    const clean: PurchaseOrderLineInput[] = [];
    for (const [index, line] of lines.entries()) {
      const drug = await stockableDrug(request.txClient, line.drugId);
      if (!drug) throw invalid(`lines[${index}].drugId is not an item of this hospital in use`);
      if (seen.has(drug.id)) throw invalid(`lines[${index}] repeats an item: one line each`);
      seen.add(drug.id);
      clean.push({ ...line, drugId: drug.id });
    }
    return clean;
  }

  async function answerOrder(request: FastifyRequest, id: string): Promise<PurchaseOrder> {
    const row = await findOrder(request.txClient, id);
    if (!row) throw orderGone();
    return orderView(row, await orderLines(request.txClient, id));
  }

  /** The order, locked, at the version sent. */
  async function toMove(
    request: FastifyRequest,
    orderId: string,
    expectedVersion: number,
  ): Promise<OrderRow> {
    const current = await lockOrder(request.txClient, orderId);
    if (!current) throw orderGone();
    if (current.version !== expectedVersion) throw conflict();
    return current;
  }

  app.get(
    '/purchasing/orders',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listPurchaseOrders',
        tags: ['purchasing'],
        description:
          'The purchase orders, newest first, of a status and a supplier when sent, without their lines. `total` comes with the first page.',
        querystring: PurchaseOrderListQuery,
        response: { 200: ref(PurchaseOrderPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const supplierId = idOrNull(request.query.supplierId);
      if (supplierId === false) return { items: [], nextCursor: null, total: 0 };
      const status = (request.query.status as OrderStatus | undefined) ?? null;
      const list = await listOrders(request.txClient, { status, supplierId, cursor, limit });
      if (!list) throw badCursor();
      return {
        items: list.rows.map(orderSummaryView),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  app.get(
    '/purchasing/orders/:orderId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getPurchaseOrder',
        tags: ['purchasing'],
        description:
          'One purchase order with its lines, each with what has been received of it. Another hospital’s answers 404.',
        params: OrderParams,
        response: { 200: ref(PurchaseOrder), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => answerOrder(request, request.params.orderId),
  );

  app.post(
    '/purchasing/orders',
    {
      // Names of items, suppliers, places and staff, and costs: no patient data.
      config: { permissions: [CREATE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createPurchaseOrder',
        tags: ['purchasing'],
        headers: IdempotencyHeaders,
        description:
          'Drafts a purchase order: a supplier in use, a place in use to deliver to, and lines of items in use, each item once (400 otherwise). It is changed freely until submitted. Numbered PO-000001 on, per hospital. Audited.',
        body: ref(PurchaseOrderCreate),
        response: { 201: ref(PurchaseOrder), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as PurchaseOrderCreate;
      const createdBy = userIdOf(request);
      const supplier = await supplierInUse(request, body.supplierId);
      const location = await place(request, body.locationId);
      const lines = await cleanLines(request, body.lines);
      const id = await insertOrder(request.txClient, {
        number: await nextNumber(request.txClient, 'order'),
        supplierId: supplier.id,
        locationId: location.id,
        note: tidyOptional(body.note, ORDER_NOTE_MAX),
        createdBy,
      });
      await replaceOrderLines(request.txClient, id, lines);
      request.audit('create', 'purchase_order', id);
      return reply.status(201).send(await answerOrder(request, id));
    },
  );

  app.patch(
    '/purchasing/orders/:orderId',
    {
      config: { permissions: [CREATE, READ], feature: FEATURE },
      schema: {
        operationId: 'updatePurchaseOrder',
        tags: ['purchasing'],
        description:
          'Changes a draft: the supplier, the place, the note (null clears it) or all its lines. 409 order_status once submitted, 409 conflict when it changed since the version sent. The same checks as drafting. Audited.',
        params: OrderParams,
        body: ref(PurchaseOrderUpdate),
        response: { 200: ref(PurchaseOrder), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as PurchaseOrderUpdate;
      const editedBy = userIdOf(request);
      const current = await toMove(request, request.params.orderId, body.expectedVersion);
      if (current.status !== 'draft') throw wrongStatus();
      const supplierId =
        body.supplierId === undefined || body.supplierId === current.supplier_id
          ? current.supplier_id
          : (await supplierInUse(request, body.supplierId)).id;
      const locationId =
        body.locationId === undefined || body.locationId === current.location_id
          ? current.location_id
          : (await place(request, body.locationId)).id;
      const note = edited(body.note, current.note, (text) => tidyOptional(text, ORDER_NOTE_MAX));
      let changed = false;
      if (
        supplierId !== current.supplier_id ||
        locationId !== current.location_id ||
        note !== current.note
      ) {
        await updateOrderFields(request.txClient, current.id, {
          supplierId,
          locationId,
          note,
          editedBy,
        });
        changed = true;
      }
      if (body.lines !== undefined) {
        const lines = await cleanLines(request, body.lines);
        const before = await orderLines(request.txClient, current.id);
        const same =
          before.length === lines.length &&
          before.every((row, index) => {
            const line = lines[index];
            return (
              line !== undefined &&
              row.drug_id === line.drugId &&
              row.quantity === line.quantity &&
              Number(row.unit_cost_minor) === line.unitCostMinor
            );
          });
        if (!same) {
          await replaceOrderLines(request.txClient, current.id, lines);
          // The order's version counts a change of its lines too.
          if (!changed) {
            await updateOrderFields(request.txClient, current.id, {
              supplierId,
              locationId,
              note,
              editedBy,
            });
          }
          changed = true;
        }
      }
      if (changed) request.audit('update', 'purchase_order', current.id);
      return answerOrder(request, current.id);
    },
  );

  app.post(
    '/purchasing/orders/:orderId/submit',
    {
      config: { permissions: [CREATE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'submitPurchaseOrder',
        tags: ['purchasing'],
        headers: IdempotencyHeaders,
        description:
          'Submits a draft for approval by someone else: it is not changed from then on. 409 order_status when it is not a draft, 409 conflict when it changed since the version sent. Audited.',
        params: OrderParams,
        body: ref(PurchaseOrderStep),
        response: { 200: ref(PurchaseOrder), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as PurchaseOrderStep;
      const by = userIdOf(request);
      const current = await toMove(request, request.params.orderId, body.expectedVersion);
      if (current.status !== 'draft') throw wrongStatus();
      await moveOrder(request.txClient, current.id, { status: 'submitted', by });
      request.audit('update', 'purchase_order', current.id);
      return answerOrder(request, current.id);
    },
  );

  app.post(
    '/purchasing/orders/:orderId/approve',
    {
      config: { permissions: [APPROVE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'approvePurchaseOrder',
        tags: ['purchasing'],
        headers: IdempotencyHeaders,
        description:
          'Approves a submitted order that someone else drafted, last changed and submitted (409 own_order): goods may then be received against it. Nothing moves in stock. 409 supplier_archived when its supplier was archived since, 409 order_status when it is not submitted, 409 conflict when it changed since the version sent. Emits `purchase.order_approved`. Audited.',
        params: OrderParams,
        body: ref(PurchaseOrderStep),
        response: { 200: ref(PurchaseOrder), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as PurchaseOrderStep;
      const by = userIdOf(request);
      const current = await toMove(request, request.params.orderId, body.expectedVersion);
      if (current.status !== 'submitted') throw wrongStatus();
      // Separation of duties: whoever wrote what is ordered, or sent it, does not approve it.
      if (current.submitted_by === by || current.created_by === by || current.edited_by === by) {
        throw new HttpError(
          409,
          'own_order',
          'Someone else approves an order you drafted, changed or submitted',
        );
      }
      const supplier = await lockSupplier(request.txClient, current.supplier_id, 'share');
      if (!supplier || supplier.archived) {
        throw new HttpError(409, 'supplier_archived', 'The supplier was archived');
      }
      await moveOrder(request.txClient, current.id, { status: 'approved', by });
      request.audit('update', 'purchase_order', current.id);
      await request.emit('purchase.order_approved', current.id, {
        orderId: current.id,
        supplierId: current.supplier_id,
        locationId: current.location_id,
      });
      return answerOrder(request, current.id);
    },
  );

  for (const action of ['cancel', 'close'] as const) {
    app.post(
      `/purchasing/orders/:orderId/${action}`,
      {
        config: { permissions: [CREATE, READ], feature: FEATURE, idempotent: { body: 'full' } },
        schema: {
          operationId: `${action}PurchaseOrder`,
          tags: ['purchasing'],
          headers: IdempotencyHeaders,
          description:
            (action === 'cancel'
              ? 'Cancels an order nothing was received against (a draft, submitted or approved), with a note saying why.'
              : 'Closes an order partly received when the rest will not come, with a note saying why: nothing more is received against it.') +
            ' 409 order_status otherwise, 409 conflict when it changed since the version sent. Audited.',
          params: OrderParams,
          body: ref(PurchaseOrderEnd),
          response: { 200: ref(PurchaseOrder), ...errors(400, 401, 403, 404, 409, 422, 429) },
        },
      },
      async (request) => {
        const body = request.body as PurchaseOrderEnd;
        const by = userIdOf(request);
        const note = tidyWithin(body.note, NOTE_MAX);
        if (note === '') throw invalid('Say why');
        const current = await toMove(request, request.params.orderId, body.expectedVersion);
        const allowed: OrderStatus[] =
          action === 'cancel' ? ['draft', 'submitted', 'approved'] : ['partly_received'];
        if (!allowed.includes(current.status)) throw wrongStatus();
        await moveOrder(request.txClient, current.id, {
          status: action === 'cancel' ? 'cancelled' : 'closed',
          by,
          note,
        });
        request.audit('update', 'purchase_order', current.id);
        return answerOrder(request, current.id);
      },
    );
  }

  // --- goods receipts --------------------------------------------------------------------------

  app.get(
    '/purchasing/receipts',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listGoodsReceipts',
        tags: ['purchasing'],
        description:
          'The goods receipts, newest first, of an order and a supplier when sent, without their lines. `total` comes with the first page.',
        querystring: GoodsReceiptListQuery,
        response: { 200: ref(GoodsReceiptPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const orderId = idOrNull(request.query.orderId);
      const supplierId = idOrNull(request.query.supplierId);
      if (orderId === false || supplierId === false) {
        return { items: [], nextCursor: null, total: 0 };
      }
      const list = await listReceipts(request.txClient, { orderId, supplierId, cursor, limit });
      if (!list) throw badCursor();
      return {
        items: list.rows.map(receiptSummaryView),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  async function answerReceipt(request: FastifyRequest, id: string): Promise<GoodsReceipt> {
    const row = await findReceipt(request.txClient, id);
    if (!row) throw receiptGone();
    return receiptView(row, await receiptLines(request.txClient, id));
  }

  app.get(
    '/purchasing/receipts/:receiptId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getGoodsReceipt',
        tags: ['purchasing'],
        description:
          'One goods receipt with its lines, each with what has been sent back of it. Another hospital’s answers 404.',
        params: ReceiptParams,
        response: { 200: ref(GoodsReceipt), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => answerReceipt(request, request.params.receiptId),
  );

  app.post(
    '/purchasing/orders/:orderId/receipts',
    {
      // Names of items, suppliers, places and staff, batches and costs: no patient data.
      config: {
        permissions: [RECEIVE, READ],
        feature: FEATURE,
        idempotent: { body: 'full' },
      },
      schema: {
        operationId: 'receiveGoods',
        tags: ['purchasing'],
        headers: IdempotencyHeaders,
        description:
          'Receives goods against an approved order (409 order_status otherwise) at a place in use (the order’s when not sent; 400 otherwise). Each line is a batch of an order line’s item as printed on the pack, with its expiry date, units and cost: a batch the item does not have is made, one it has of the same expiry date is added to (409 batch_exists for another expiry date), one already expired is 409 batch_expired. Each batch once (400). More than an order line still waits for is 409 over_receipt, a cost above the order line’s agreed price is 409 cost_above_order (the approval covered that price; a dearer delivery needs a new order), and an item archived since is 409 item_archived. Each line comes into stock through the ledger at once; the order becomes partly received or received. Numbered GRN-000001 on. Emits `stock.received`. Audited.',
        params: OrderParams,
        body: ref(GoodsReceiptCreate),
        response: { 201: ref(GoodsReceipt), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as GoodsReceiptCreate;
      const receivedBy = userIdOf(request);
      // Held so two receipts of the order take their turn and neither receives too much.
      const order = await lockOrder(request.txClient, request.params.orderId);
      if (!order) throw orderGone();
      if (order.status !== 'approved' && order.status !== 'partly_received') throw wrongStatus();
      const location = await place(request, body.locationId ?? order.location_id);
      const ordered = new Map(
        (await orderLines(request.txClient, order.id)).map((line) => [line.id, line]),
      );
      const coming = new Map<string, number>();
      const batches = new Set<string>();
      const lines = body.lines.map((line, index) => {
        const orderLine = ordered.get(line.orderLineId.toLowerCase());
        if (!orderLine) throw invalid(`lines[${index}].orderLineId is not a line of the order`);
        if (!realDay(line.expiryDate)) throw invalid(`lines[${index}].expiryDate is not a day`);
        const batchNumber = tidyWithin(line.batchNumber, BATCH_NUMBER_MAX);
        if (batchNumber === '') throw invalid(`lines[${index}].batchNumber is required`);
        if (line.unitCostMinor > Number(orderLine.unit_cost_minor)) {
          throw new HttpError(
            409,
            'cost_above_order',
            'A unit costs more than the order line’s agreed price',
          );
        }
        const batchKey = `${orderLine.drug_id}:${batchNumber.toUpperCase()}`;
        if (batches.has(batchKey)) throw invalid(`lines[${index}] repeats a batch: one line each`);
        batches.add(batchKey);
        coming.set(orderLine.id, (coming.get(orderLine.id) ?? 0) + line.quantity);
        return { ...line, batchNumber, orderLine, lineNumber: index + 1 };
      });
      for (const [orderLineId, quantity] of coming) {
        const orderLine = ordered.get(orderLineId);
        if (orderLine && orderLine.received_quantity + quantity > orderLine.quantity) {
          throw new HttpError(
            409,
            'over_receipt',
            'More units than the order line still waits for',
          );
        }
      }
      const receiptId = await insertReceipt(request.txClient, {
        number: await nextNumber(request.txClient, 'receipt'),
        orderId: order.id,
        supplierId: order.supplier_id,
        locationId: location.id,
        supplierInvoice: tidyOptional(body.supplierInvoice, INVOICE_MAX),
        note: tidyOptional(body.note, NOTE_MAX),
        receivedBy,
      });
      // One movement per item, so each item's lock is taken once, and the items in id order, as
      // every movement of several items takes them, so two never wait for each other.
      const drugIds = [...new Set(lines.map((line) => line.orderLine.drug_id))].sort();
      for (const drugId of drugIds) {
        if (!(await stockableDrug(request.txClient, drugId))) {
          throw new HttpError(409, 'item_archived', 'An item was archived since it was ordered');
        }
      }
      for (const drugId of drugIds) {
        const ofItem = lines.filter((line) => line.orderLine.drug_id === drugId);
        const posted = await stockReceive(request, {
          locationId: location.id,
          drugId,
          sourceId: receiptId,
          actorId: receivedBy,
          lines: ofItem.map((line) => ({
            batchNumber: line.batchNumber,
            expiryDate: line.expiryDate,
            mrpMinor: line.mrpMinor ?? null,
            costMinor: line.unitCostMinor,
            quantity: line.quantity,
          })),
        });
        for (const [index, line] of ofItem.entries()) {
          const entry = posted[index];
          if (!entry) throw new Error('a line was not posted');
          await insertReceiptLine(request.txClient, {
            receiptId,
            orderId: order.id,
            orderLineId: line.orderLine.id,
            lineNumber: line.lineNumber,
            drugId,
            batchId: entry.batchId,
            quantity: line.quantity,
            unitCostMinor: line.unitCostMinor,
            ledgerEntryId: entry.ledgerEntryId,
          });
        }
      }
      const full = [...ordered.values()].every(
        (line) => line.received_quantity + (coming.get(line.id) ?? 0) >= line.quantity,
      );
      const status = full ? 'received' : 'partly_received';
      // Always, so the order's version moves with what it has received.
      await moveOrder(request.txClient, order.id, { status });
      request.audit('create', 'goods_receipt', receiptId);
      request.audit('update', 'purchase_order', order.id);
      await request.emit('stock.received', receiptId, {
        receiptId,
        orderId: order.id,
        supplierId: order.supplier_id,
        locationId: location.id,
      });
      return reply.status(201).send(await answerReceipt(request, receiptId));
    },
  );

  // --- returns to the supplier -----------------------------------------------------------------

  app.get(
    '/purchasing/returns',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listPurchaseReturns',
        tags: ['purchasing'],
        description:
          'The returns to suppliers, newest first, of a receipt and a supplier when sent, with their lines. `total` comes with the first page.',
        querystring: PurchaseReturnListQuery,
        response: { 200: ref(PurchaseReturnPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const receiptId = idOrNull(request.query.receiptId);
      const supplierId = idOrNull(request.query.supplierId);
      if (receiptId === false || supplierId === false) {
        return { items: [], nextCursor: null, total: 0 };
      }
      const list = await listReturns(request.txClient, { receiptId, supplierId, cursor, limit });
      if (!list) throw badCursor();
      const lines = await returnLines(
        request.txClient,
        list.rows.map((row) => row.id),
      );
      return {
        items: list.rows.map((row) => returnView(row, lines)),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  app.post(
    '/purchasing/receipts/:receiptId/returns',
    {
      // Names of items, suppliers, places and staff, batches and costs: no patient data.
      config: { permissions: [RETURN, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'returnToSupplier',
        tags: ['purchasing'],
        headers: IdempotencyHeaders,
        description:
          'Sends units of a goods receipt back to its supplier, from a place in use (the receipt’s when not sent; 400 otherwise), with a reason (a note for other, 400). Each receipt line once (400), no more than it brought in less what has gone back already (409 over_return), and no more than its batch has at the place (409 insufficient_stock). Expired units may go back. They leave stock through the ledger at once. Numbered PRN-000001 on. Emits `stock.returned`, and `stock.low` when it brings the hospital’s stock of an item to its reorder level. Audited.',
        params: ReceiptParams,
        body: ref(PurchaseReturnCreate),
        response: { 201: ref(PurchaseReturn), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as PurchaseReturnCreate;
      const returnedBy = userIdOf(request);
      const note = tidyOptional(body.note, NOTE_MAX);
      if (body.reason === 'other' && note === null) throw invalid('Say why, for another reason');
      // Held so two returns of the receipt take their turn and neither sends back too much.
      const receipt = await lockReceipt(request.txClient, request.params.receiptId);
      if (!receipt) throw receiptGone();
      const location = await place(request, body.locationId ?? receipt.location_id);
      const received = new Map(
        (await receiptLines(request.txClient, receipt.id)).map((line) => [line.id, line]),
      );
      const seen = new Set<string>();
      const lines = body.lines.map((line, index) => {
        const receiptLine = received.get(line.receiptLineId.toLowerCase());
        if (!receiptLine)
          throw invalid(`lines[${index}].receiptLineId is not a line of the receipt`);
        if (seen.has(receiptLine.id)) throw invalid(`lines[${index}] repeats a line: once each`);
        seen.add(receiptLine.id);
        if (receiptLine.returned_quantity + line.quantity > receiptLine.quantity) {
          throw new HttpError(409, 'over_return', 'More units than the line brought in and kept');
        }
        return { quantity: line.quantity, receiptLine };
      });
      const returnId = await insertReturn(request.txClient, {
        number: await nextNumber(request.txClient, 'return'),
        receiptId: receipt.id,
        supplierId: receipt.supplier_id,
        locationId: location.id,
        reason: body.reason,
        note,
        returnedBy,
      });
      // In id order, as every movement of several items takes them.
      const drugIds = [...new Set(lines.map((line) => line.receiptLine.drug_id))].sort();
      for (const drugId of drugIds) {
        const ofItem = lines.filter((line) => line.receiptLine.drug_id === drugId);
        // An archived item may still go back: it has no reorder level to cross then.
        const drug = await stockableDrug(request.txClient, drugId);
        const posted = await stockOut(request, {
          locationId: location.id,
          drugId,
          reorderLevel: drug?.reorderLevel ?? null,
          source: 'purchase_return',
          sourceId: returnId,
          reason: 'purchase_return',
          actorId: returnedBy,
          lines: ofItem.map((line) => ({
            batchId: line.receiptLine.batch_id,
            quantity: line.quantity,
          })),
          expiredAllowed: true,
        });
        for (const [index, line] of ofItem.entries()) {
          const entry = posted[index];
          if (!entry) throw new Error('a line was not posted');
          await insertReturnLine(request.txClient, {
            returnId,
            receiptId: receipt.id,
            receiptLineId: line.receiptLine.id,
            batchId: line.receiptLine.batch_id,
            quantity: line.quantity,
            ledgerEntryId: entry.ledgerEntryId,
          });
        }
      }
      request.audit('create', 'purchase_return', returnId);
      await request.emit('stock.returned', returnId, {
        returnId,
        receiptId: receipt.id,
        supplierId: receipt.supplier_id,
        locationId: location.id,
        reason: body.reason,
      });
      const row = await findReturn(request.txClient, returnId);
      if (!row) throw returnGone();
      return reply
        .status(201)
        .send(returnView(row, await returnLines(request.txClient, [returnId])));
    },
  );
};
