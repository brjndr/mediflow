import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  GoodsReceipt,
  GoodsReceiptLine,
  GoodsReceiptPage,
  GoodsReceiptSummary,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderPage,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  PurchaseReturn,
  PurchaseReturnPage,
  PurchaseReturnReason,
  Supplier,
  SupplierPage,
} from './types';

export const ORDER_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'partly_received',
  'received',
  'closed',
  'cancelled',
] as const satisfies readonly PurchaseOrderStatus[];
export const RETURN_REASONS = [
  'expired',
  'damaged',
  'wrong_item',
  'other',
] as const satisfies readonly PurchaseReturnReason[];

/** The API's limits. */
export const SUPPLIER_NAME_MAX = 120;
export const DRUG_LICENCE_MAX = 60;
export const PHONE_MAX = 20;
export const EMAIL_MAX = 254;
export const ADDRESS_MAX = 300;
export const ORDER_NOTE_MAX = 500;
export const NOTE_MAX = 200;
export const INVOICE_MAX = 60;
export const BATCH_NUMBER_MAX = 40;
export const ORDER_LINES_MAX = 200;
export const RECEIPT_LINES_MAX = 400;
export const QUANTITY_MAX = 1_000_000;
/** India's GST number: two digits of the state, then thirteen capital letters and digits. */
export const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;

const page = <Item>(item: z.ZodType<Item>) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

export const supplierSchema: z.ZodType<Supplier> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  gstin: z.string().optional(),
  drugLicence: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  archived: z.boolean(),
  version: z.number().int(),
});
export const supplierPageSchema: z.ZodType<SupplierPage> = page(supplierSchema);

const orderFields = {
  id: z.string(),
  tenantId: z.string(),
  reference: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  status: z.enum(ORDER_STATUSES),
  totalMinor: z.number().int(),
  createdById: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  submittedById: z.string().optional(),
  version: z.number().int(),
};

const orderSummarySchema: z.ZodType<PurchaseOrderSummary> = z.object({
  ...orderFields,
  lineCount: z.number().int(),
});
export const orderPageSchema: z.ZodType<PurchaseOrderPage> = page(orderSummarySchema);

const orderLineSchema: z.ZodType<PurchaseOrderLine> = z.object({
  id: z.string(),
  lineNumber: z.number().int(),
  drugId: z.string(),
  itemName: z.string(),
  unit: z.string().optional(),
  quantity: z.number().int(),
  unitCostMinor: z.number().int(),
  receivedQuantity: z.number().int(),
});

export const orderSchema: z.ZodType<PurchaseOrder> = z.object({
  ...orderFields,
  note: z.string().optional(),
  lines: z.array(orderLineSchema),
  editedById: z.string(),
  submittedByName: z.string().optional(),
  submittedAt: z.string().optional(),
  approvedByName: z.string().optional(),
  approvedAt: z.string().optional(),
  endedByName: z.string().optional(),
  endedAt: z.string().optional(),
  endNote: z.string().optional(),
});

const receiptFields = {
  id: z.string(),
  tenantId: z.string(),
  reference: z.string(),
  orderId: z.string(),
  orderReference: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  supplierInvoice: z.string().optional(),
  totalMinor: z.number().int(),
  receivedByName: z.string(),
  receivedAt: z.string(),
};

const receiptSummarySchema: z.ZodType<GoodsReceiptSummary> = z.object({
  ...receiptFields,
  lineCount: z.number().int(),
});
export const receiptPageSchema: z.ZodType<GoodsReceiptPage> = page(receiptSummarySchema);

const receiptLineSchema: z.ZodType<GoodsReceiptLine> = z.object({
  id: z.string(),
  lineNumber: z.number().int(),
  orderLineId: z.string(),
  drugId: z.string(),
  itemName: z.string(),
  unit: z.string().optional(),
  batchId: z.string(),
  batchNumber: z.string(),
  expiryDate: z.string(),
  mrpMinor: z.number().int().optional(),
  quantity: z.number().int(),
  unitCostMinor: z.number().int(),
  returnedQuantity: z.number().int(),
});

export const receiptSchema: z.ZodType<GoodsReceipt> = z.object({
  ...receiptFields,
  note: z.string().optional(),
  lines: z.array(receiptLineSchema),
});

export const returnSchema: z.ZodType<PurchaseReturn> = z.object({
  id: z.string(),
  tenantId: z.string(),
  reference: z.string(),
  receiptId: z.string(),
  receiptReference: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  reason: z.enum(RETURN_REASONS),
  note: z.string().optional(),
  lines: z.array(
    z.object({
      id: z.string(),
      receiptLineId: z.string(),
      drugId: z.string(),
      itemName: z.string(),
      batchId: z.string(),
      batchNumber: z.string(),
      expiryDate: z.string(),
      quantity: z.number().int(),
      unitCostMinor: z.number().int(),
    }),
  ),
  totalMinor: z.number().int(),
  returnedByName: z.string(),
  returnedAt: z.string(),
});
export const returnPageSchema: z.ZodType<PurchaseReturnPage> = page(returnSchema);

// --- forms -------------------------------------------------------------------------------------

const plain = (max: number) =>
  z.string().trim().max(max, 'validation.too_big').regex(PLAIN_TEXT, 'validation.plain_text');

/** Whether a YYYY-MM-DD text is a day of the calendar: not 2027-02-30. */
export function realDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const day = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
}

const wholeUnits = (required: boolean) =>
  z
    .string()
    .trim()
    .refine((text) => (required ? text !== '' : true), 'validation.required')
    .refine((text) => text === '' || /^\d+$/.test(text), 'purchasing:form.wholeUnits')
    .refine(
      (text) => text === '' || (Number(text) >= 1 && Number(text) <= QUANTITY_MAX),
      'purchasing:form.unitsRange',
    );

export const supplierFormSchema = z.object({
  name: plain(SUPPLIER_NAME_MAX).min(1, 'validation.required'),
  gstin: z
    .string()
    .trim()
    .transform((text) => text.toUpperCase())
    .refine((text) => text === '' || GSTIN.test(text), 'purchasing:suppliers.gstinInvalid'),
  drugLicence: plain(DRUG_LICENCE_MAX),
  phone: plain(PHONE_MAX).refine(
    (text) => text === '' || text.length >= 5,
    'purchasing:suppliers.phoneShort',
  ),
  email: plain(EMAIL_MAX).refine(
    (text) => text === '' || /^[^\s@]+@[^\s@]+$/.test(text),
    'purchasing:suppliers.emailInvalid',
  ),
  address: z
    .string()
    .trim()
    .max(ADDRESS_MAX, 'validation.too_big')
    .regex(PLAIN_LINES, 'validation.plain_text'),
});
export type SupplierFormInput = z.input<typeof supplierFormSchema>;
export type SupplierFormValues = z.output<typeof supplierFormSchema>;

/**
 * A purchase order as typed: a supplier and a place, a note, and its lines, each an item chosen
 * with the search (its id and name held by the form), whole units and the price of one.
 * `checkMoney` turns a typed amount into minor units, null when it is not one.
 */
export function createOrderFormSchema(checkMoney: (text: string) => number | null) {
  return z.object({
    supplierId: z.string().min(1, 'validation.required'),
    locationId: z.string().min(1, 'validation.required'),
    note: plain(ORDER_NOTE_MAX),
    lines: z
      .array(
        z.object({
          drugId: z.string(),
          name: z.string(),
          quantity: wholeUnits(true),
          unitCost: z
            .string()
            .trim()
            .min(1, 'validation.required')
            .refine((text) => checkMoney(text) !== null, 'purchasing:form.amountInvalid'),
        }),
      )
      .min(1, 'purchasing:order.form.noLines')
      .max(ORDER_LINES_MAX, 'validation.too_big'),
  });
}
export type OrderFormValues = z.output<ReturnType<typeof createOrderFormSchema>>;

/**
 * Goods received, as typed: the supplier's invoice, a note, and a row per batch, each of an order
 * line with its batch number, expiry date (in date at the hospital today), units, the cost of one
 * (never above the line's agreed price, `agreed`) and the printed price. A row with no units is not
 * sent; at least one has some, and an order line's rows never bring more than it still waits for
 * (`left`).
 */
export function createReceiveFormSchema(
  checkMoney: (text: string) => number | null,
  today: string,
  left: Record<string, number>,
  agreed: Record<string, number>,
) {
  return z
    .object({
      supplierInvoice: plain(INVOICE_MAX),
      note: plain(NOTE_MAX),
      rows: z.array(
        z.object({
          orderLineId: z.string(),
          batchNumber: plain(BATCH_NUMBER_MAX),
          expiryDate: z.string(),
          quantity: wholeUnits(false),
          unitCost: z.string().trim(),
          mrp: z.string().trim(),
        }),
      ),
    })
    .superRefine((values, context) => {
      const issue = (path: (string | number)[], message: string) =>
        context.addIssue({ code: 'custom', path, message });
      const sent = values.rows.filter((row) => row.quantity !== '');
      // On the first row's units, so a failed submit has a field to focus.
      if (sent.length === 0) issue(['rows', 0, 'quantity'], 'purchasing:receive.nothing');
      const coming: Record<string, number> = {};
      const numbers = new Set<string>();
      values.rows.forEach((row, index) => {
        if (row.quantity === '') return;
        if (row.batchNumber === '') issue(['rows', index, 'batchNumber'], 'validation.required');
        const key = `${row.orderLineId}:${row.batchNumber.toUpperCase()}`;
        if (row.batchNumber !== '' && numbers.has(key)) {
          issue(['rows', index, 'batchNumber'], 'purchasing:receive.batchTwice');
        }
        numbers.add(key);
        if (!realDay(row.expiryDate)) issue(['rows', index, 'expiryDate'], 'validation.required');
        else if (row.expiryDate < today) {
          issue(['rows', index, 'expiryDate'], 'purchasing:receive.expired');
        }
        if (row.unitCost === '') issue(['rows', index, 'unitCost'], 'validation.required');
        else if (checkMoney(row.unitCost) === null) {
          issue(['rows', index, 'unitCost'], 'purchasing:form.amountInvalid');
        } else if ((checkMoney(row.unitCost) ?? 0) > (agreed[row.orderLineId] ?? 0)) {
          issue(['rows', index, 'unitCost'], 'purchasing:receive.costAbove');
        }
        if (row.mrp !== '' && checkMoney(row.mrp) === null) {
          issue(['rows', index, 'mrp'], 'purchasing:form.amountInvalid');
        }
        const sum = (coming[row.orderLineId] ?? 0) + Number(row.quantity);
        coming[row.orderLineId] = sum;
        if (sum > (left[row.orderLineId] ?? 0)) {
          issue(['rows', index, 'quantity'], 'purchasing:receive.tooMany');
        }
      });
    });
}
export type ReceiveFormValues = z.output<ReturnType<typeof createReceiveFormSchema>>;

/** Units of a receipt's lines sent back: each no more than is `left`, some at least, and why. */
export function createReturnFormSchema(left: number[]) {
  return z
    .object({
      reason: z.enum(RETURN_REASONS, { message: 'validation.required' }),
      note: plain(NOTE_MAX),
      units: z.array(wholeUnits(false)),
    })
    .superRefine((values, context) => {
      const issue = (path: (string | number)[], message: string) =>
        context.addIssue({ code: 'custom', path, message });
      if (values.units.every((units) => units === '')) {
        issue(['units', 0], 'purchasing:return.nothing');
      }
      values.units.forEach((units, index) => {
        if (units !== '' && Number(units) > (left[index] ?? 0)) {
          issue(['units', index], 'purchasing:return.tooMany');
        }
      });
      if (values.reason === 'other' && values.note === '') {
        issue(['note'], 'purchasing:return.noteForOther');
      }
    });
}
export type ReturnFormValues = z.output<ReturnType<typeof createReturnFormSchema>>;

export const endFormSchema = z.object({
  note: plain(NOTE_MAX).min(1, 'purchasing:order.end.noteRequired'),
});
export type EndFormValues = z.infer<typeof endFormSchema>;
