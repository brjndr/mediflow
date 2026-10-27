import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

export const SUPPLIER_NAME_MAX = 120;
export const DRUG_LICENCE_MAX = 60;
export const PHONE_MAX = 20;
export const EMAIL_MAX = 254;
export const ADDRESS_MAX = 300;
export const ORDER_NOTE_MAX = 500;
export const NOTE_MAX = 200;
export const INVOICE_MAX = 60;
export const BATCH_NUMBER_MAX = 40;
/** The most lines of one order, and of one receipt (an order line may come in several batches). */
export const ORDER_LINES_MAX = 200;
export const RECEIPT_LINES_MAX = 400;
export const QUANTITY_MAX = 1_000_000;
export const MONEY_MAX = 100_000_000_000;
/** India's GST number: two digits of the state, then thirteen letters and digits. */
export const GSTIN = '^[0-9]{2}[A-Z0-9]{13}$';

// The enums carry an $id, unlike `StringEnum`, so the contract names them as the web app does.
const named = <const Values extends readonly string[]>(
  $id: string,
  values: Values,
  description: string,
) => Type.Unsafe<Values[number]>({ $id, type: 'string', enum: [...values], description });

export const ORDER_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'partly_received',
  'received',
  'closed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const PurchaseOrderStatus = named(
  'PurchaseOrderStatus',
  ORDER_STATUSES,
  'A draft is changed freely; submitted, it waits for someone else to approve it; approved, goods are received against it, partly then in full. One partly received may be closed when the rest will not come; one with nothing received may be cancelled.',
);

export const RETURN_REASONS = ['expired', 'damaged', 'wrong_item', 'other'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const PurchaseReturnReason = named(
  'PurchaseReturnReason',
  RETURN_REASONS,
  'Why goods go back to the supplier: expired, damaged, not what was ordered, or another reason given in the note.',
);

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({
  description:
    'Counts the changes. Sent back as expectedVersion; another one gives 409 `conflict`.',
});
const ExpectedVersion = Type.Integer({ description: 'The version the change was made from.' });
const Money = Type.Integer({ minimum: 0, maximum: MONEY_MAX });
const Quantity = Type.Integer({ minimum: 1, maximum: QUANTITY_MAX });
const CalendarDate = Type.String({
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'A calendar date, not an instant: YYYY-MM-DD.',
});
const Text = (max: number, min = 1) =>
  Type.String({ minLength: min, maxLength: max, pattern: PLAIN_TEXT });
/** Optional on an edit: null clears it. */
const Clearable = (max: number, pattern: string = PLAIN_TEXT) =>
  Type.Optional(Type.Unsafe<string | null>({ type: ['string', 'null'], maxLength: max, pattern }));
const Note = Text(NOTE_MAX);

// --- suppliers ---------------------------------------------------------------------------------

export const Supplier = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    name: Type.String(),
    gstin: Type.Optional(Type.String()),
    drugLicence: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
    address: Type.Optional(Type.String()),
    archived: Type.Boolean(),
    version: Version,
  },
  { $id: 'Supplier', description: 'A business the hospital buys drugs and consumables from.' },
);
export type Supplier = Static<typeof Supplier>;

export const SupplierPage = CursorPage(ref(Supplier), { $id: 'SupplierPage' });

export const SupplierListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  archived: Type.Optional(
    Type.Boolean({ description: 'The archived suppliers instead of those in use.' }),
  ),
  q: Type.Optional(
    Type.String({ maxLength: 100, description: 'Only suppliers whose name has this in it.' }),
  ),
});
export type SupplierListQuery = Static<typeof SupplierListQuery>;

export const SupplierCreate = Type.Object(
  {
    name: Text(SUPPLIER_NAME_MAX),
    gstin: Type.Optional(
      Type.String({
        pattern: GSTIN,
        description: 'The GST number: 15 capital letters and digits.',
      }),
    ),
    drugLicence: Type.Optional(Text(DRUG_LICENCE_MAX)),
    phone: Type.Optional(Text(PHONE_MAX, 5)),
    email: Type.Optional(Text(EMAIL_MAX, 3)),
    address: Type.Optional(
      Type.String({ minLength: 1, maxLength: ADDRESS_MAX, pattern: PLAIN_LINES }),
    ),
  },
  { $id: 'SupplierCreate', additionalProperties: false },
);
export type SupplierCreate = Static<typeof SupplierCreate>;

export const SupplierUpdate = Type.Object(
  {
    expectedVersion: ExpectedVersion,
    name: Type.Optional(Text(SUPPLIER_NAME_MAX)),
    gstin: Clearable(15, GSTIN),
    drugLicence: Clearable(DRUG_LICENCE_MAX),
    phone: Clearable(PHONE_MAX),
    email: Clearable(EMAIL_MAX),
    address: Clearable(ADDRESS_MAX, PLAIN_LINES),
  },
  {
    $id: 'SupplierUpdate',
    additionalProperties: false,
    description: 'Only the fields sent change; null clears an optional one.',
  },
);
export type SupplierUpdate = Static<typeof SupplierUpdate>;

// --- purchase orders ---------------------------------------------------------------------------

export const PurchaseOrderLine = Type.Object(
  {
    id: Type.String(),
    lineNumber: Type.Integer(),
    drugId: Type.String(),
    itemName: Type.String({ description: 'Generic name, strength and brand, as it reads now.' }),
    unit: Type.Optional(Type.String({ description: 'What one unit is.' })),
    quantity: Type.Integer({ description: 'Units ordered.' }),
    unitCostMinor: Type.Integer({ description: 'The agreed price of a unit before tax.' }),
    receivedQuantity: Type.Integer({ description: 'Units received against the line so far.' }),
  },
  { $id: 'PurchaseOrderLine' },
);
export type PurchaseOrderLine = Static<typeof PurchaseOrderLine>;

const orderFields = {
  id: Type.String(),
  tenantId: Type.String(),
  reference: Type.String({ description: 'The order’s number as printed: PO-000123.' }),
  supplierId: Type.String(),
  supplierName: Type.String(),
  locationId: Type.String(),
  locationName: Type.String({ description: 'Where the goods are to be delivered.' }),
  status: ref(PurchaseOrderStatus),
  totalMinor: Type.Integer({
    description: 'The lines’ quantities at their unit costs, before tax.',
  }),
  createdById: Type.String(),
  createdByName: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
  submittedById: Type.Optional(
    Type.String({ description: 'Who submitted it: someone else approves it.' }),
  ),
  version: Version,
};

export const PurchaseOrderSummary = Type.Object(
  { ...orderFields, lineCount: Type.Integer() },
  { $id: 'PurchaseOrderSummary', description: 'A purchase order as a list shows it.' },
);
export type PurchaseOrderSummary = Static<typeof PurchaseOrderSummary>;

export const PurchaseOrderPage = CursorPage(ref(PurchaseOrderSummary), {
  $id: 'PurchaseOrderPage',
});

export const PurchaseOrder = Type.Object(
  {
    ...orderFields,
    note: Type.Optional(Type.String()),
    lines: Type.Array(ref(PurchaseOrderLine)),
    editedById: Type.String({
      description:
        'Who last changed what is ordered. Neither they, the creator nor the submitter approves it.',
    }),
    submittedByName: Type.Optional(Type.String()),
    submittedAt: Type.Optional(Type.String({ format: 'date-time' })),
    approvedByName: Type.Optional(Type.String()),
    approvedAt: Type.Optional(Type.String({ format: 'date-time' })),
    endedByName: Type.Optional(
      Type.String({ description: 'Who cancelled it, or closed it with goods still to come.' }),
    ),
    endedAt: Type.Optional(Type.String({ format: 'date-time' })),
    endNote: Type.Optional(Type.String()),
  },
  {
    $id: 'PurchaseOrder',
    description:
      'What the hospital asks a supplier for, approved by a second person before goods are received against it.',
  },
);
export type PurchaseOrder = Static<typeof PurchaseOrder>;

export const PurchaseOrderListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  status: Type.Optional(ref(PurchaseOrderStatus)),
  supplierId: Type.Optional(Id),
});
export type PurchaseOrderListQuery = Static<typeof PurchaseOrderListQuery>;

export const PurchaseOrderLineInput = Type.Object(
  { drugId: Id, quantity: Quantity, unitCostMinor: Money },
  { $id: 'PurchaseOrderLineInput', additionalProperties: false },
);
export type PurchaseOrderLineInput = Static<typeof PurchaseOrderLineInput>;

const OrderLines = Type.Array(ref(PurchaseOrderLineInput), {
  minItems: 1,
  maxItems: ORDER_LINES_MAX,
  description: 'Each item once.',
});

export const PurchaseOrderCreate = Type.Object(
  {
    supplierId: Id,
    locationId: Type.String({ maxLength: 64, description: 'Where the goods are to be delivered.' }),
    note: Type.Optional(Text(ORDER_NOTE_MAX)),
    lines: OrderLines,
  },
  { $id: 'PurchaseOrderCreate', additionalProperties: false },
);
export type PurchaseOrderCreate = Static<typeof PurchaseOrderCreate>;

export const PurchaseOrderUpdate = Type.Object(
  {
    expectedVersion: ExpectedVersion,
    supplierId: Type.Optional(Id),
    locationId: Type.Optional(Id),
    note: Clearable(ORDER_NOTE_MAX),
    lines: Type.Optional(OrderLines),
  },
  {
    $id: 'PurchaseOrderUpdate',
    additionalProperties: false,
    description: 'A draft only. Only the fields sent change; lines sent replace them all.',
  },
);
export type PurchaseOrderUpdate = Static<typeof PurchaseOrderUpdate>;

export const PurchaseOrderStep = Type.Object(
  { expectedVersion: ExpectedVersion },
  { $id: 'PurchaseOrderStep', additionalProperties: false },
);
export type PurchaseOrderStep = Static<typeof PurchaseOrderStep>;

export const PurchaseOrderEnd = Type.Object(
  { expectedVersion: ExpectedVersion, note: Note },
  { $id: 'PurchaseOrderEnd', additionalProperties: false },
);
export type PurchaseOrderEnd = Static<typeof PurchaseOrderEnd>;

// --- goods receipts ----------------------------------------------------------------------------

export const GoodsReceiptLine = Type.Object(
  {
    id: Type.String(),
    lineNumber: Type.Integer(),
    orderLineId: Type.String(),
    drugId: Type.String(),
    itemName: Type.String(),
    unit: Type.Optional(Type.String()),
    batchId: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    mrpMinor: Type.Optional(Type.Integer({ description: 'The batch’s maximum retail price.' })),
    quantity: Type.Integer(),
    unitCostMinor: Type.Integer({ description: 'What a unit of this delivery cost, before tax.' }),
    returnedQuantity: Type.Integer({ description: 'Units of the line sent back so far.' }),
  },
  { $id: 'GoodsReceiptLine' },
);
export type GoodsReceiptLine = Static<typeof GoodsReceiptLine>;

const receiptFields = {
  id: Type.String(),
  tenantId: Type.String(),
  reference: Type.String({ description: 'The receipt’s number as printed: GRN-000123.' }),
  orderId: Type.String(),
  orderReference: Type.String(),
  supplierId: Type.String(),
  supplierName: Type.String(),
  locationId: Type.String(),
  locationName: Type.String(),
  supplierInvoice: Type.Optional(
    Type.String({ description: 'The supplier’s invoice or delivery note.' }),
  ),
  totalMinor: Type.Integer({ description: 'The lines at their unit costs, before tax.' }),
  receivedByName: Type.String(),
  receivedAt: Type.String({ format: 'date-time' }),
};

export const GoodsReceiptSummary = Type.Object(
  { ...receiptFields, lineCount: Type.Integer() },
  { $id: 'GoodsReceiptSummary', description: 'A goods receipt as a list shows it.' },
);
export type GoodsReceiptSummary = Static<typeof GoodsReceiptSummary>;

export const GoodsReceiptPage = CursorPage(ref(GoodsReceiptSummary), { $id: 'GoodsReceiptPage' });

export const GoodsReceipt = Type.Object(
  {
    ...receiptFields,
    note: Type.Optional(Type.String()),
    lines: Type.Array(ref(GoodsReceiptLine)),
  },
  {
    $id: 'GoodsReceipt',
    description:
      'Goods that came in against an approved order: each line a batch brought into stock through the ledger. Never changed: a correction is a return or an adjustment.',
  },
);
export type GoodsReceipt = Static<typeof GoodsReceipt>;

export const GoodsReceiptListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  orderId: Type.Optional(Id),
  supplierId: Type.Optional(Id),
});
export type GoodsReceiptListQuery = Static<typeof GoodsReceiptListQuery>;

export const GoodsReceiptLineInput = Type.Object(
  {
    orderLineId: Id,
    batchNumber: Type.String({
      minLength: 1,
      maxLength: BATCH_NUMBER_MAX,
      pattern: PLAIN_TEXT,
      description: 'As printed on the pack.',
    }),
    expiryDate: CalendarDate,
    quantity: Quantity,
    unitCostMinor: Money,
    mrpMinor: Type.Optional(Money),
  },
  { $id: 'GoodsReceiptLineInput', additionalProperties: false },
);
export type GoodsReceiptLineInput = Static<typeof GoodsReceiptLineInput>;

export const GoodsReceiptCreate = Type.Object(
  {
    locationId: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'Where the goods came in: the order’s place when not sent.',
      }),
    ),
    supplierInvoice: Type.Optional(Text(INVOICE_MAX)),
    note: Type.Optional(Note),
    lines: Type.Array(ref(GoodsReceiptLineInput), {
      minItems: 1,
      maxItems: RECEIPT_LINES_MAX,
      description: 'Each batch once; an order line may come in several batches.',
    }),
  },
  { $id: 'GoodsReceiptCreate', additionalProperties: false },
);
export type GoodsReceiptCreate = Static<typeof GoodsReceiptCreate>;

// --- returns to the supplier -------------------------------------------------------------------

export const PurchaseReturnLine = Type.Object(
  {
    id: Type.String(),
    receiptLineId: Type.String(),
    drugId: Type.String(),
    itemName: Type.String(),
    batchId: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    quantity: Type.Integer(),
    unitCostMinor: Type.Integer({ description: 'What a unit cost when received.' }),
  },
  { $id: 'PurchaseReturnLine' },
);

export const PurchaseReturn = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    reference: Type.String({ description: 'The return’s number as printed: PRN-000123.' }),
    receiptId: Type.String(),
    receiptReference: Type.String(),
    supplierId: Type.String(),
    supplierName: Type.String(),
    locationId: Type.String(),
    locationName: Type.String({ description: 'Where the units were taken from.' }),
    reason: ref(PurchaseReturnReason),
    note: Type.Optional(Type.String()),
    lines: Type.Array(ref(PurchaseReturnLine)),
    totalMinor: Type.Integer({ description: 'The lines at their received costs.' }),
    returnedByName: Type.String(),
    returnedAt: Type.String({ format: 'date-time' }),
  },
  {
    $id: 'PurchaseReturn',
    description:
      'Units of a goods receipt sent back to the supplier, taken out of stock through the ledger. Never changed.',
  },
);
export type PurchaseReturn = Static<typeof PurchaseReturn>;

export const PurchaseReturnPage = CursorPage(ref(PurchaseReturn), { $id: 'PurchaseReturnPage' });

export const PurchaseReturnListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  receiptId: Type.Optional(Id),
  supplierId: Type.Optional(Id),
});
export type PurchaseReturnListQuery = Static<typeof PurchaseReturnListQuery>;

export const PurchaseReturnLineInput = Type.Object(
  { receiptLineId: Id, quantity: Quantity },
  { $id: 'PurchaseReturnLineInput', additionalProperties: false },
);

export const PurchaseReturnCreate = Type.Object(
  {
    locationId: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'Where the units are taken from: the receipt’s place when not sent.',
      }),
    ),
    reason: ref(PurchaseReturnReason),
    note: Type.Optional(Type.String({ ...Note, description: 'Needed when the reason is other.' })),
    lines: Type.Array(ref(PurchaseReturnLineInput), {
      minItems: 1,
      maxItems: RECEIPT_LINES_MAX,
      description: 'Each receipt line once.',
    }),
  },
  { $id: 'PurchaseReturnCreate', additionalProperties: false },
);
export type PurchaseReturnCreate = Static<typeof PurchaseReturnCreate>;

export const PURCHASING_SCHEMAS = [
  PurchaseOrderStatus,
  PurchaseReturnReason,
  Supplier,
  SupplierPage,
  SupplierCreate,
  SupplierUpdate,
  PurchaseOrderLine,
  PurchaseOrderSummary,
  PurchaseOrderPage,
  PurchaseOrder,
  PurchaseOrderLineInput,
  PurchaseOrderCreate,
  PurchaseOrderUpdate,
  PurchaseOrderStep,
  PurchaseOrderEnd,
  GoodsReceiptLine,
  GoodsReceiptSummary,
  GoodsReceiptPage,
  GoodsReceipt,
  GoodsReceiptLineInput,
  GoodsReceiptCreate,
  PurchaseReturnLine,
  PurchaseReturn,
  PurchaseReturnPage,
  PurchaseReturnLineInput,
  PurchaseReturnCreate,
] as const;
