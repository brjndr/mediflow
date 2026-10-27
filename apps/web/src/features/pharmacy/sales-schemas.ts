import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { QUANTITY_MAX, REASON_MAX } from './schemas';
import type {
  DrugRegisterEntry,
  DrugRegisterPage,
  PharmacySale,
  SaleItemOptions,
  SaleListItem,
  SalePage,
} from './types';

/** The API's limits (#101). */
export const SALE_ITEMS_MAX = 20;
export const PRESCRIBER_NAME_MAX = 120;
export const PRESCRIBER_REGISTRATION_MAX = 40;
export const REGISTER_DAYS_MAX = 366;

const page = <Item>(item: z.ZodType<Item>) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

export const saleItemOptionsSchema: z.ZodType<SaleItemOptions> = z.object({
  drugId: z.string(),
  name: z.string(),
  schedule: z.string(),
  controlled: z.boolean(),
  needsPrescription: z.boolean(),
  inRegister: z.boolean(),
  batches: z.array(
    z.object({
      batchId: z.string(),
      batchNumber: z.string(),
      expiryDate: z.string(),
      onHand: z.number().int(),
      mrpMinor: z.string().optional(),
    }),
  ),
});

export const saleSchema: z.ZodType<PharmacySale> = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  patientId: z.string().optional(),
  patientName: z.string().optional(),
  patientMrn: z.string().optional(),
  prescriberName: z.string().optional(),
  prescriberRegistration: z.string().optional(),
  prescribedOn: z.string().optional(),
  totalMinor: z.string(),
  returnedMinor: z.string(),
  soldAt: z.string(),
  soldByName: z.string(),
  lines: z.array(
    z.object({
      id: z.string(),
      lineNumber: z.number().int(),
      drugId: z.string(),
      itemName: z.string(),
      schedule: z.string(),
      controlled: z.boolean(),
      batchId: z.string(),
      batchNumber: z.string(),
      expiryDate: z.string(),
      quantity: z.number().int(),
      returnedQuantity: z.number().int(),
      unitPriceMinor: z.string(),
    }),
  ),
  returns: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
      totalMinor: z.string(),
      returnedAt: z.string(),
      returnedByName: z.string(),
      lines: z.array(z.object({ saleLineId: z.string(), quantity: z.number().int() })),
    }),
  ),
});

const saleListItemSchema: z.ZodType<SaleListItem> = z.object({
  id: z.string(),
  soldAt: z.string(),
  soldByName: z.string(),
  locationName: z.string(),
  patientId: z.string().optional(),
  patientName: z.string().optional(),
  patientMrn: z.string().optional(),
  lineCount: z.number().int(),
  totalMinor: z.string(),
  returnedMinor: z.string(),
});
export const salePageSchema: z.ZodType<SalePage> = page(saleListItemSchema);

const registerEntrySchema: z.ZodType<DrugRegisterEntry> = z.object({
  id: z.string(),
  at: z.string(),
  locationName: z.string(),
  batchNumber: z.string(),
  expiryDate: z.string(),
  quantity: z.number().int(),
  balanceAfter: z.number().int(),
  source: z.string(),
  sourceId: z.string(),
  reason: z.string(),
  actorName: z.string(),
  patientId: z.string().optional(),
  patientName: z.string().optional(),
  patientMrn: z.string().optional(),
  prescriptionId: z.string().optional(),
  prescriberName: z.string().optional(),
  prescriberRegistration: z.string().optional(),
});
export const registerPageSchema: z.ZodType<DrugRegisterPage> = page(registerEntrySchema);

/**
 * Units of an item taken from its batches nearest expiry first (they come so ordered), only from
 * those with a price: what a sale sends for it. Null when the batches here do not hold that many.
 */
export function takeFromBatches(
  batches: SaleItemOptions['batches'],
  wanted: number,
): { batchId: string; quantity: number; priceMinor: number }[] | null {
  let left = wanted;
  const taken: { batchId: string; quantity: number; priceMinor: number }[] = [];
  for (const batch of batches) {
    if (left === 0) break;
    if (batch.mrpMinor === undefined) continue;
    const take = Math.min(left, batch.onHand);
    taken.push({ batchId: batch.batchId, quantity: take, priceMinor: Number(batch.mrpMinor) });
    left -= take;
  }
  return left === 0 ? taken : null;
}

/** Units of an item that can be sold here: in the batches with a price. */
export const sellableUnits = (batches: SaleItemOptions['batches']): number =>
  batches.reduce((sum, batch) => sum + (batch.mrpMinor === undefined ? 0 : batch.onHand), 0);

const WHOLE = /^\d{1,5}$/;

const PRESCRIPTION_FIELDS = ['prescriberName', 'prescriberRegistration', 'prescribedOn'] as const;

/**
 * The sale form: the cart, a row per item with its units typed with digits, and the outside
 * prescription, which comes whole or not at all. Whether the cart needs one is known only once
 * its items are read, so the screen checks that on sending (`missingPrescription`), as it checks
 * the patient. `today` is the hospital's, `YYYY-MM-DD`.
 */
export function createSaleFormSchema(today: string) {
  const text = (max: number) =>
    z.string().trim().max(max, 'validation.too_big').regex(PLAIN_TEXT, 'validation.plain_text');
  return z
    .object({
      lines: z.array(z.object({ drugId: z.string(), name: z.string(), units: z.string().trim() })),
      prescriberName: text(PRESCRIBER_NAME_MAX),
      prescriberRegistration: text(PRESCRIBER_REGISTRATION_MAX),
      prescribedOn: z.string(),
    })
    .superRefine((values, context) => {
      if (values.lines.length === 0) {
        context.addIssue({ code: 'custom', path: ['lines'], message: 'pharmacy:sale.form.empty' });
      }
      values.lines.forEach((line, index) => {
        const units = WHOLE.test(line.units) ? Number(line.units) : Number.NaN;
        if (!Number.isInteger(units) || units < 1 || units > QUANTITY_MAX) {
          context.addIssue({
            code: 'custom',
            path: ['lines', index, 'units'],
            message: 'pharmacy:sale.form.wholeUnits',
          });
        }
      });
      const any = PRESCRIPTION_FIELDS.some((name) => values[name] !== '');
      if (!any) return;
      for (const name of PRESCRIPTION_FIELDS) {
        if (values[name] !== '') continue;
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'pharmacy:sale.form.prescriptionWhole',
        });
      }
      if (values.prescribedOn !== '' && values.prescribedOn > today) {
        context.addIssue({
          code: 'custom',
          path: ['prescribedOn'],
          message: 'pharmacy:sale.form.prescribedAhead',
        });
      }
    });
}
export type SaleFormValues = z.infer<ReturnType<typeof createSaleFormSchema>>;

/** The prescription fields left empty when the cart needs a prescription, in their order. */
export const missingPrescription = (values: SaleFormValues) =>
  PRESCRIPTION_FIELDS.filter((name) => values[name] === '');

/** The return form: the units brought back of each line still to return (`left`), and why. */
export function createReturnFormSchema(left: readonly number[]) {
  return z
    .object({
      reason: z
        .string()
        .trim()
        .min(1, 'pharmacy:sale.return.reasonRequired')
        .max(REASON_MAX, 'validation.too_big')
        .regex(PLAIN_TEXT, 'validation.plain_text'),
      units: z.array(z.string().trim()),
    })
    .superRefine((values, context) => {
      let total = 0;
      values.units.forEach((typed, index) => {
        if (typed === '') return;
        const units = WHOLE.test(typed) ? Number(typed) : Number.NaN;
        if (!Number.isInteger(units)) {
          context.addIssue({
            code: 'custom',
            path: ['units', index],
            message: 'pharmacy:sale.return.wholeUnits',
          });
          return;
        }
        if (units > (left[index] ?? 0)) {
          context.addIssue({
            code: 'custom',
            path: ['units', index],
            message: 'pharmacy:sale.return.tooMany',
          });
          return;
        }
        total += units;
      });
      if (total === 0) {
        context.addIssue({
          code: 'custom',
          path: ['units', 0],
          message: 'pharmacy:sale.return.nothing',
        });
      }
    });
}
export type ReturnFormValues = z.infer<ReturnType<typeof createReturnFormSchema>>;
