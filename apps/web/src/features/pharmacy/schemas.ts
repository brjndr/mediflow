import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  DispensableItem,
  Dispense,
  DispenseOptions,
  PharmacyLine,
  PharmacyPrescription,
  PharmacyQueueItem,
  PharmacyQueuePage,
} from './types';

/** The API's limits. */
export const REASON_MAX = 200;
export const BATCHES_MAX = 10;
/** The most units one dispense gives. */
export const QUANTITY_MAX = 10_000;
/** The windows of the queue a screen offers, in days; the API takes 1 to 90. */
export const QUEUE_WINDOWS = [1, 3, 7, 30, 90] as const;
export const QUEUE_DAYS_DEFAULT = 7;

const page = <Item>(item: z.ZodType<Item>) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

const queueItemSchema: z.ZodType<PharmacyQueueItem> = z.object({
  prescriptionId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  prescribedAt: z.string(),
  prescribedByName: z.string(),
  lineCount: z.number().int(),
  openLineCount: z.number().int(),
  startedLineCount: z.number().int(),
});
export const queuePageSchema: z.ZodType<PharmacyQueuePage> = page(queueItemSchema);

const ORDER_STATUSES = ['placed', 'accepted', 'in_progress', 'completed', 'cancelled'] as const;

const lineSchema: z.ZodType<PharmacyLine> = z.object({
  orderId: z.string(),
  lineNumber: z.number().int(),
  version: z.number().int(),
  status: z.enum(ORDER_STATUSES),
  drugId: z.string(),
  itemName: z.string(),
  dose: z.string(),
  frequency: z.string(),
  route: z.string(),
  durationDays: z.number().int().optional(),
  quantity: z.number().int().optional(),
  instructions: z.string().optional(),
  cancelReason: z.string().optional(),
  dispensedQuantity: z.number().int(),
});

export const dispenseSchema: z.ZodType<Dispense> = z.object({
  id: z.string(),
  orderId: z.string(),
  prescriptionId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  prescribedDrugId: z.string(),
  drugId: z.string(),
  itemName: z.string(),
  schedule: z.string(),
  controlled: z.boolean(),
  substitutionReason: z.string().optional(),
  quantity: z.number().int(),
  batches: z.array(
    z.object({
      batchId: z.string(),
      batchNumber: z.string(),
      expiryDate: z.string(),
      quantity: z.number().int(),
    }),
  ),
  dispensedAt: z.string(),
  dispensedByName: z.string(),
});

export const prescriptionSchema: z.ZodType<PharmacyPrescription> = z.object({
  prescriptionId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  prescribedAt: z.string(),
  prescribedByName: z.string(),
  advice: z.string().optional(),
  replacesId: z.string().optional(),
  replacedById: z.string().optional(),
  lines: z.array(lineSchema),
  dispenses: z.array(dispenseSchema),
});

const itemSchema: z.ZodType<DispensableItem> = z.object({
  drugId: z.string(),
  name: z.string(),
  schedule: z.string(),
  controlled: z.boolean(),
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

export const optionsSchema: z.ZodType<DispenseOptions> = z.object({
  prescribed: itemSchema.optional(),
  substitutes: z.array(itemSchema),
});

/** Units still to give of a line: null when the doctor gave no quantity. */
export const remainingOf = (line: PharmacyLine): number | null =>
  line.quantity === undefined ? null : Math.max(0, line.quantity - line.dispensedQuantity);

/** Whether a line may still be dispensed against. */
export const isOpen = (line: PharmacyLine) =>
  line.status === 'placed' || line.status === 'accepted' || line.status === 'in_progress';

/**
 * Units to take from each batch to give `wanted`, nearest expiry first (the batches come so
 * ordered), as whole numbers as typed: the form's starting values.
 */
export function nearestExpiryFirst(
  batches: readonly { onHand: number }[],
  wanted: number | null,
): string[] {
  let left = wanted ?? 0;
  return batches.map((batch) => {
    const take = Math.min(left, batch.onHand);
    left -= take;
    return take > 0 ? String(take) : '';
  });
}

const WHOLE = /^\d{1,5}$/;

/**
 * The dispense form: the item (the prescribed one, or a substitute with a reason) and the units
 * of each of its batches at the place, typed with digits. Checked against the batches offered and
 * what is left to give, as the API checks them.
 */
export function createDispenseFormSchema(
  items: readonly DispensableItem[],
  prescribedDrugId: string,
  remaining: number | null,
) {
  return z
    .object({
      drugId: z.string(),
      reason: z
        .string()
        .max(REASON_MAX, 'validation.too_big')
        .regex(PLAIN_TEXT, 'validation.plain_text'),
      batches: z.array(z.string().trim()),
    })
    .superRefine((values, context) => {
      const item = items.find((each) => each.drugId === values.drugId);
      if (!item) {
        context.addIssue({
          code: 'custom',
          path: ['drugId'],
          message: 'pharmacy:dispense.form.chooseItem',
        });
        return;
      }
      if (values.drugId !== prescribedDrugId && values.reason.trim() === '') {
        context.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'pharmacy:dispense.form.reasonRequired',
        });
      }
      let total = 0;
      let used = 0;
      // A total is said under the last batch typed into, where the person is: an item offered
      // always has a batch, so there is always a field to say it under.
      let last = 0;
      item.batches.forEach((batch, index) => {
        const typed = values.batches[index] ?? '';
        if (typed === '') return;
        const units = WHOLE.test(typed) ? Number(typed) : Number.NaN;
        if (!Number.isInteger(units) || units < 0) {
          context.addIssue({
            code: 'custom',
            path: ['batches', index],
            message: 'pharmacy:dispense.form.wholeUnits',
          });
          return;
        }
        if (units > batch.onHand) {
          context.addIssue({
            code: 'custom',
            path: ['batches', index],
            message: 'pharmacy:dispense.form.moreThanHere',
          });
          return;
        }
        if (units > 0) used += 1;
        total += units;
        last = index;
      });
      if (total === 0) {
        context.addIssue({
          code: 'custom',
          path: ['batches', 0],
          message: 'pharmacy:dispense.form.nothing',
        });
      } else if (remaining !== null && total > remaining) {
        context.addIssue({
          code: 'custom',
          path: ['batches', last],
          message: 'pharmacy:dispense.form.tooMuch',
        });
      } else if (total > QUANTITY_MAX) {
        context.addIssue({
          code: 'custom',
          path: ['batches', last],
          message: 'pharmacy:dispense.form.tooManyUnits',
        });
      } else if (used > BATCHES_MAX) {
        context.addIssue({
          code: 'custom',
          path: ['batches', last],
          message: 'pharmacy:dispense.form.tooManyBatches',
        });
      }
    });
}
export type DispenseFormValues = z.infer<ReturnType<typeof createDispenseFormSchema>>;
