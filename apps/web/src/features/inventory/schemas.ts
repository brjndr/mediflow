import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  StockAdjustment,
  StockAdjustmentPage,
  StockAdjustmentReason,
  StockAdjustmentStatus,
  StockAlertCounts,
  StockBatchBalance,
  StockExpiryState,
  StockItem,
  StockItemName,
  StockItemPage,
  StockLedgerEntry,
  StockLedgerPage,
  StockLocation,
  StockLocationKind,
  StockLocationPage,
} from './types';

export const LOCATION_KINDS = [
  'store',
  'pharmacy',
  'ward',
] as const satisfies readonly StockLocationKind[];
export const REASONS = [
  'opening',
  'count_correction',
  'damaged',
  'expired',
  'other',
] as const satisfies readonly StockAdjustmentReason[];
export const STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const satisfies readonly StockAdjustmentStatus[];
const EXPIRY_STATES = ['ok', 'expiring', 'expired'] as const satisfies readonly StockExpiryState[];
export const ALERTS = ['low', 'expiring', 'expired'] as const;
/** The windows of "expiring" a screen offers, in days; the API takes 1 to 365. */
export const EXPIRING_WINDOWS = [30, 60, 90, 180] as const;
export const EXPIRING_DEFAULT = 90;

/** The API's limits. */
export const LOCATION_NAME_MAX = 100;
export const BATCH_NUMBER_MAX = 40;
export const NOTE_MAX = 200;
export const QUANTITY_MAX = 1_000_000;

const page = <Item>(item: z.ZodType<Item>) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

export const stockLocationSchema: z.ZodType<StockLocation> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  kind: z.enum(LOCATION_KINDS),
  archived: z.boolean(),
  version: z.number().int(),
});
export const stockLocationPageSchema: z.ZodType<StockLocationPage> = page(stockLocationSchema);

const itemNameSchema: z.ZodType<StockItemName> = z.object({
  drugId: z.string(),
  type: z.enum(['medicine', 'consumable']),
  genericName: z.string(),
  brandName: z.string().optional(),
  form: z.string(),
  strength: z.string().optional(),
  unit: z.string().optional(),
});

const batchBalanceSchema: z.ZodType<StockBatchBalance> = z.object({
  batchId: z.string(),
  batchNumber: z.string(),
  expiryDate: z.string(),
  mrpMinor: z.number().int().optional(),
  locationId: z.string(),
  locationName: z.string(),
  onHand: z.number().int(),
  expiry: z.enum(EXPIRY_STATES),
});

const stockItemSchema: z.ZodType<StockItem> = z.object({
  item: itemNameSchema,
  reorderLevel: z.number().int().optional(),
  onHand: z.number().int(),
  hospitalOnHand: z.number().int(),
  low: z.boolean(),
  batches: z.array(batchBalanceSchema),
});
export const stockItemPageSchema: z.ZodType<StockItemPage> = page(stockItemSchema);

export const alertCountsSchema: z.ZodType<StockAlertCounts> = z.object({
  low: z.number().int(),
  expiring: z.number().int(),
  expired: z.number().int(),
});

const ledgerEntrySchema: z.ZodType<StockLedgerEntry> = z.object({
  id: z.string(),
  at: z.string(),
  item: itemNameSchema,
  batchId: z.string(),
  batchNumber: z.string(),
  expiryDate: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  quantity: z.number().int(),
  balanceAfter: z.number().int(),
  source: z.enum(['adjustment', 'dispense']),
  sourceId: z.string(),
  // A dispense (#100) takes units out with the reason `dispense`, which no adjustment has.
  reason: z.enum([...REASONS, 'dispense']),
  actorName: z.string(),
});
export const ledgerPageSchema: z.ZodType<StockLedgerPage> = page(ledgerEntrySchema);

export const adjustmentSchema: z.ZodType<StockAdjustment> = z.object({
  id: z.string(),
  tenantId: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  item: itemNameSchema,
  batchId: z.string().optional(),
  batchNumber: z.string(),
  expiryDate: z.string(),
  newBatch: z.boolean(),
  mrpMinor: z.number().int().optional(),
  costMinor: z.number().int().optional(),
  quantity: z.number().int(),
  reason: z.enum(REASONS),
  note: z.string().optional(),
  onHand: z.number().int(),
  status: z.enum(STATUSES),
  requestedById: z.string(),
  requestedByName: z.string(),
  requestedAt: z.string(),
  decidedByName: z.string().optional(),
  decidedAt: z.string().optional(),
  rejectionNote: z.string().optional(),
  version: z.number().int(),
});
export const adjustmentPageSchema: z.ZodType<StockAdjustmentPage> = page(adjustmentSchema);

const plain = (max: number) =>
  z.string().trim().max(max, 'validation.too_big').regex(PLAIN_TEXT, 'validation.plain_text');

export const locationFormSchema = z.object({
  name: plain(LOCATION_NAME_MAX).min(1, 'validation.required'),
  kind: z.enum(LOCATION_KINDS, { message: 'validation.required' }),
});
export type LocationFormValues = z.infer<typeof locationFormSchema>;

export const rejectFormSchema = z.object({
  note: plain(NOTE_MAX).min(1, 'inventory:adjust.reject.noteRequired'),
});
export type RejectFormValues = z.infer<typeof rejectFormSchema>;

/** Whether a YYYY-MM-DD text is a day of the calendar: not 2027-02-30. */
function realDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const day = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
}

/** Which way a reason moves stock: fixed for opening, damaged and expired, chosen otherwise. */
export const FIXED_DIRECTION: Partial<Record<StockAdjustmentReason, 'in' | 'out'>> = {
  opening: 'in',
  damaged: 'out',
  expired: 'out',
};

/**
 * An adjustment as typed: a place, an item (chosen with the search, its id held by the form), a
 * batch of it or a new batch for opening stock, a whole number in or out as the reason allows,
 * and a note. `checkMoney` turns a typed price into minor units, null when it is not one.
 */
export function createAdjustmentFormSchema(checkMoney: (text: string) => number | null) {
  return z
    .object({
      locationId: z.string().min(1, 'validation.required'),
      drugId: z.string().min(1, 'inventory:adjust.itemRequired'),
      reason: z.enum(REASONS, { message: 'validation.required' }),
      /** An existing batch's id, or `new`. */
      batch: z.string().min(1, 'validation.required'),
      batchNumber: plain(BATCH_NUMBER_MAX),
      expiryDate: z.string(),
      mrp: z.string().trim(),
      direction: z.enum(['in', 'out']),
      quantity: z
        .string()
        .trim()
        .regex(/^\d+$/, 'inventory:adjust.quantityWhole')
        .refine(
          (text) => Number(text) >= 1 && Number(text) <= QUANTITY_MAX,
          'inventory:adjust.quantityRange',
        ),
      note: plain(NOTE_MAX),
    })
    .superRefine((values, context) => {
      const isNew = values.batch === 'new';
      const issue = (path: string, message: string) =>
        context.addIssue({ code: 'custom', path: [path], message });
      if (isNew && values.reason !== 'opening')
        issue('batch', 'inventory:adjust.newBatchOpeningOnly');
      if (isNew && values.batchNumber === '') issue('batchNumber', 'validation.required');
      if (isNew && !realDay(values.expiryDate)) {
        issue('expiryDate', 'validation.required');
      }
      if (isNew && values.mrp !== '' && checkMoney(values.mrp) === null) {
        issue('mrp', 'inventory:adjust.mrpInvalid');
      }
      const fixed = FIXED_DIRECTION[values.reason];
      if (fixed && fixed !== values.direction)
        issue('direction', 'inventory:adjust.directionFixed');
      if (values.reason === 'other' && values.note === '')
        issue('note', 'inventory:adjust.noteForOther');
    });
}
export type AdjustmentFormInput = z.input<ReturnType<typeof createAdjustmentFormSchema>>;
export type AdjustmentFormValues = z.output<ReturnType<typeof createAdjustmentFormSchema>>;
