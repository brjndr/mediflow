import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  MarEntry,
  MarEntryCorrect,
  MarEntryCreate,
  MarEntryPage,
  MarOrder,
  MarOrderPage,
  MarOutcome,
} from './types';

export const OUTCOMES = ['given', 'withheld', 'refused', 'missed'] as const satisfies MarOutcome[];
export const ROUTES = [
  'oral',
  'sublingual',
  'topical',
  'inhaled',
  'nasal',
  'eye',
  'ear',
  'rectal',
  'vaginal',
  'intramuscular',
  'intravenous',
  'subcutaneous',
  'other',
] as const;
export const DOSE_MAX = 50;
export const MAR_REASON_MAX = 200;

const outcome = z.enum(OUTCOMES);

export const marOrderSchema: z.ZodType<MarOrder> = z.object({
  id: z.string(),
  drugId: z.string(),
  itemName: z.string(),
  dose: z.string(),
  route: z.string(),
  frequency: z.string(),
  status: z.string(),
  placedAt: z.string(),
  dispensed: z.boolean(),
});

export const marOrderPageSchema: z.ZodType<MarOrderPage> = z.object({
  items: z.array(marOrderSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const marEntrySchema: z.ZodType<MarEntry> = z.object({
  id: z.string(),
  tenantId: z.string(),
  admissionId: z.string(),
  orderId: z.string(),
  drugId: z.string(),
  scheduledAt: z.string(),
  outcome,
  doseGiven: z.string().optional(),
  route: z.string().optional(),
  reason: z.string().optional(),
  administeredAt: z.string().optional(),
  recordedAt: z.string(),
  recordedById: z.string(),
  recordedByName: z.string(),
  witnessId: z.string().optional(),
  correctsId: z.string().optional(),
  correctedById: z.string().optional(),
  warnings: z.array(z.enum(['not_dispensed'])).optional(),
});

export const marEntryPageSchema: z.ZodType<MarEntryPage> = z.object({
  items: z.array(marEntrySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

// --- the form ----------------------------------------------------------------------------------

export interface DoseContext {
  /** The dose of the order: a different dose given needs a reason. */
  orderDose: string;
  /** Amending an entry: a reason is always needed. */
  amending: boolean;
  /** The patient's allergies cover this medicine: the nurse must confirm having checked. */
  allergyHit: boolean;
  /** The server said the dose is beyond the doses a day the frequency allows. */
  extraDose: boolean;
}

const fields = z.object({
  outcome,
  doseGiven: z
    .string()
    .trim()
    .max(DOSE_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  route: z.string(),
  reason: z
    .string()
    .trim()
    .max(MAR_REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  allergyChecked: z.boolean(),
});
export type MarValues = z.infer<typeof fields>;

/** True when the dose typed is not the order's dose (compared without case or spacing). */
export function differsFromOrder(given: string, orderDose: string): boolean {
  const norm = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, '');
  return norm(given) !== norm(orderDose);
}

/** The dose checks: what a nurse must say before a dose is charted. */
export function marFormSchema(context: DoseContext) {
  return fields.superRefine((values, issues) => {
    const add = (path: keyof MarValues, message: string) =>
      issues.addIssue({ code: 'custom', path: [path], message });
    if (values.outcome === 'given') {
      if (values.doseGiven === '') add('doseGiven', 'validation.required');
      if (
        values.reason === '' &&
        values.doseGiven !== '' &&
        differsFromOrder(values.doseGiven, context.orderDose)
      ) {
        add('reason', 'nursing:mar.errors.doseReason');
      }
      if (values.reason === '' && context.extraDose) add('reason', 'nursing:mar.errors.extraDose');
      if (context.allergyHit && !values.allergyChecked) {
        add('allergyChecked', 'nursing:mar.errors.allergy');
      }
    } else if (values.reason === '') {
      add('reason', 'nursing:mar.errors.reason');
    }
    if (context.amending && values.reason === '') add('reason', 'nursing:mar.errors.amendReason');
  });
}

export function blankMar(order: MarOrder, entry?: MarEntry): MarValues {
  return {
    outcome: entry?.outcome ?? 'given',
    doseGiven: entry?.doseGiven ?? order.dose,
    route: entry?.route ?? ((ROUTES as readonly string[]).includes(order.route) ? order.route : ''),
    reason: '',
    allergyChecked: false,
  };
}

/** The body for a new entry; what a dose that was not given never carries is left out. */
export function toCreate(
  values: MarValues,
  slot: { admissionId: string; orderId: string; scheduledAt: string },
): MarEntryCreate {
  const body: MarEntryCreate = { ...slot, outcome: values.outcome };
  if (values.outcome === 'given') {
    body.doseGiven = values.doseGiven;
    if (values.route) body.route = values.route as NonNullable<MarEntryCreate['route']>;
  }
  if (values.reason) body.reason = values.reason;
  return body;
}

export function toCorrect(values: MarValues): MarEntryCorrect {
  const body: MarEntryCorrect = { outcome: values.outcome, reason: values.reason };
  if (values.outcome === 'given') {
    body.doseGiven = values.doseGiven;
    if (values.route) body.route = values.route as NonNullable<MarEntryCorrect['route']>;
  }
  return body;
}
