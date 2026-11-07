import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { MEDICATION_ROUTES, prescriptionFormSchema, type PrescriptionLineValues } from './schemas';
import type {
  PrescriptionSet,
  PrescriptionSetDetail,
  PrescriptionSetLine,
  PrescriptionSetLineView,
  PrescriptionSetPage,
} from './types';

// Prescription sets (#394): named lists of medicine lines, loaded into a prescription.

export const SET_NAME_MAX = 100;

const setSchema: z.ZodType<PrescriptionSet> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  shared: z.boolean(),
  lineCount: z.number().int(),
  archived: z.boolean(),
  version: z.number().int(),
  updatedAt: z.string(),
});

export const setPageSchema: z.ZodType<PrescriptionSetPage> = z.object({
  items: z.array(setSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const setDetailSchema: z.ZodType<PrescriptionSetDetail> = z.object({
  set: setSchema,
  lines: z.array(
    z.object({
      drugId: z.string(),
      drugName: z.string(),
      drugArchived: z.boolean(),
      genericName: z.string(),
      brandName: z.string().optional(),
      dose: z.string(),
      route: z.enum(MEDICATION_ROUTES),
      frequency: z.string(),
      durationDays: z.number().int().optional(),
      quantity: z.number().int().optional(),
      instructions: z.string().optional(),
    }),
  ),
});

/** The dialog that saves the lines of the form as a set. */
export const saveSetSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(SET_NAME_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  shared: z.boolean(),
});
/** The dialog that edits a set: its name (the lines are removed one by one). */
export const renameSetSchema = saveSetSchema.pick({ name: true });
export type RenameSetValues = z.input<typeof renameSetSchema>;
export type RenameSetOutput = z.output<typeof renameSetSchema>;
export type SaveSetValues = z.input<typeof saveSetSchema>;
export type SaveSetOutput = z.output<typeof saveSetSchema>;

/** A line of a set as a line of the form: the medicine named as the catalog names it now. */
export function setLineToValues(line: PrescriptionSetLineView): PrescriptionLineValues {
  return {
    drugId: line.drugId,
    drugName: line.drugName,
    genericName: line.genericName,
    brandName: line.brandName ?? '',
    dose: line.dose,
    route: line.route,
    frequency: line.frequency,
    durationDays: line.durationDays === undefined ? '' : String(line.durationDays),
    quantity: line.quantity === undefined ? '' : String(line.quantity),
    instructions: line.instructions ?? '',
  };
}

/** True for a line nothing was typed into: the one a new form starts with. */
export const isBlankLine = (line: PrescriptionLineValues): boolean =>
  line.drugId === '' &&
  line.dose.trim() === '' &&
  line.frequency.trim() === '' &&
  line.durationDays.trim() === '' &&
  line.quantity.trim() === '' &&
  line.instructions.trim() === '';

/**
 * The lines the form holds, if each is complete, as a set takes them; null when one is not. They
 * are checked as a prescription checks them, so a set never holds what could not be written.
 */
export function toSetLines(lines: PrescriptionLineValues[]): PrescriptionSetLine[] | null {
  const parsed = prescriptionFormSchema(false).shape.lines.safeParse(lines);
  if (!parsed.success) return null;
  return parsed.data.map((line) => ({
    drugId: line.drugId,
    dose: line.dose,
    route: line.route,
    frequency: line.frequency,
    ...(line.durationDays ? { durationDays: Number(line.durationDays) } : {}),
    ...(line.quantity ? { quantity: Number(line.quantity) } : {}),
    ...(line.instructions ? { instructions: line.instructions } : {}),
  }));
}

/** A line of a set as the API takes it back, without the names the view adds. */
export const lineOfView = (line: PrescriptionSetLineView): PrescriptionSetLine => ({
  drugId: line.drugId,
  dose: line.dose,
  route: line.route,
  frequency: line.frequency,
  ...(line.durationDays === undefined ? {} : { durationDays: line.durationDays }),
  ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
  ...(line.instructions === undefined ? {} : { instructions: line.instructions }),
});
