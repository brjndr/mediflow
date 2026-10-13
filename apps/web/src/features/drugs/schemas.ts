import { z } from 'zod';
import type { Drug, DrugCreate, DrugPage, DrugSchedule } from './types';
import { PLAIN_TEXT } from '@/shared/utils/text';

export const TYPES = ['medicine', 'consumable'] as const;
export const FORMS = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'injection',
  'infusion',
  'cream',
  'ointment',
  'drops',
  'inhaler',
  'powder',
  'device',
  'other',
] as const;
export const SCHEDULES = ['none', 'h', 'h1', 'x', 'g', 'narcotic'] as const;
export const TAX_CLASSES = ['exempt', 'reduced', 'standard', 'higher'] as const;

/** Schedules whose items are always handled as controlled drugs, whatever else is chosen. */
export const alwaysControlled = (schedule: DrugSchedule | ''): boolean =>
  schedule === 'x' || schedule === 'narcotic';

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const drugSchema: z.ZodType<Drug> = z.object({
  id: z.string(),
  tenantId: z.string(),
  type: z.enum(TYPES),
  genericName: z.string(),
  brandName: z.string().optional(),
  form: z.enum(FORMS),
  strength: z.string().optional(),
  unit: z.string().optional(),
  schedule: z.enum(SCHEDULES),
  controlled: z.boolean(),
  taxClass: z.enum(TAX_CLASSES),
  reorderLevel: z.number().int().min(0).optional(),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

export const drugPageSchema: z.ZodType<DrugPage> = z.object({
  items: z.array(drugSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const drugMatchesSchema = z.object({ items: z.array(drugSchema) });

export const NAME_MAX = 150;
export const SHORT_MAX = 30;
const REORDER_MAX = 1_000_000;

/** The add and edit form. Messages are translation keys in core `common`. */
export const drugFormSchema = z.object({
  type: z.enum(TYPES, 'validation.required'),
  genericName: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(NAME_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  brandName: z.string().trim().max(NAME_MAX).regex(PLAIN_TEXT, 'validation.plain_text'),
  form: z.enum(FORMS, 'validation.required'),
  strength: z.string().trim().max(SHORT_MAX).regex(PLAIN_TEXT, 'validation.plain_text'),
  unit: z.string().trim().max(SHORT_MAX).regex(PLAIN_TEXT, 'validation.plain_text'),
  schedule: z.enum(SCHEDULES, 'validation.required'),
  controlled: z.boolean(),
  taxClass: z.enum(TAX_CLASSES, 'validation.required'),
  // Typed as text: empty means no level is set.
  reorderLevel: z
    .string()
    .trim()
    .refine(
      (text) => text === '' || (/^\d{1,7}$/.test(text) && Number(text) <= REORDER_MAX),
      'validation.invalid_format',
    ),
});
export type DrugFormValues = z.infer<typeof drugFormSchema>;
export type DrugField = keyof DrugFormValues;

/** What the form holds for an item, or for a new one. */
export const toFormValues = (drug?: Drug) => ({
  type: drug?.type ?? '',
  genericName: drug?.genericName ?? '',
  brandName: drug?.brandName ?? '',
  form: drug?.form ?? '',
  strength: drug?.strength ?? '',
  unit: drug?.unit ?? '',
  schedule: drug?.schedule ?? 'none',
  controlled: drug?.controlled ?? false,
  taxClass: drug?.taxClass ?? '',
  reorderLevel: drug?.reorderLevel === undefined ? '' : String(drug.reorderLevel),
});

/**
 * A new item as the API takes it: an optional field that was left empty is left out.
 */
export function toCreate(values: DrugFormValues): DrugCreate {
  const { brandName, strength, unit, ...rest } = toRequest(values);
  return {
    ...rest,
    ...(brandName ? { brandName } : {}),
    ...(strength ? { strength } : {}),
    ...(unit ? { unit } : {}),
  };
}

/**
 * The form's values as the API takes them. An empty optional field is sent as empty text, which
 * the API reads as "none": on a change that is how a brand or a strength is removed.
 */
export function toRequest(values: DrugFormValues): DrugCreate {
  return {
    type: values.type,
    genericName: values.genericName,
    brandName: values.brandName,
    form: values.form,
    strength: values.strength,
    unit: values.unit,
    schedule: values.schedule,
    controlled: values.controlled || alwaysControlled(values.schedule),
    taxClass: values.taxClass,
    ...(values.reorderLevel === '' ? {} : { reorderLevel: Number(values.reorderLevel) }),
  };
}
