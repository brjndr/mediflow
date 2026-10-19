import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  AllergyList,
  AllergyListUpdate,
  AllergySeverity,
  Vitals,
  VitalsCreate,
  VitalsPage,
  VitalRange,
  VitalRanges,
} from './types';

/** The measurements a hospital's ranges can mark abnormal, in the order they are shown. */
export const RANGED = ['systolic', 'diastolic', 'pulse', 'temperature', 'spo2'] as const;
export type RangedMeasure = (typeof RANGED)[number];

/** Every measurement of a reading, in the order the form and the history show them. */
export const MEASURES = [...RANGED, 'weight', 'height'] as const;
export type Measure = (typeof MEASURES)[number];

export const SEVERITIES = [
  'severe',
  'moderate',
  'mild',
  'unknown',
] as const satisfies readonly AllergySeverity[];

const COMPLAINT_MAX = 500;
const REASON_MAX = 200;
const SUBSTANCE_MAX = 100;
const REACTION_MAX = 200;
export const ALLERGIES_MAX = 50;

// Responses are validated where they enter the app, so screens can trust their shape.

const measurements = {
  systolic: z.number().int().optional(),
  diastolic: z.number().int().optional(),
  pulse: z.number().int().optional(),
  temperature: z.number().optional(),
  spo2: z.number().int().optional(),
  weight: z.number().optional(),
  height: z.number().optional(),
};

export const vitalsSchema: z.ZodType<Vitals> = z.object({
  id: z.string(),
  tenantId: z.string(),
  patientId: z.string(),
  queueTokenId: z.string().optional(),
  encounterId: z.string().optional(),
  recordedAt: z.string(),
  recordedById: z.string(),
  recordedByName: z.string(),
  ...measurements,
  chiefComplaint: z.string().optional(),
  correctsId: z.string().optional(),
  correctionReason: z.string().optional(),
});

export const vitalsPageSchema: z.ZodType<VitalsPage> = z.object({
  items: z.array(vitalsSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const rangeSchema: z.ZodType<VitalRange> = z.object({
  low: z.number().optional(),
  high: z.number().optional(),
});

export const vitalRangesSchema: z.ZodType<VitalRanges> = z.object({
  ranges: z
    .object({
      systolic: rangeSchema.optional(),
      diastolic: rangeSchema.optional(),
      pulse: rangeSchema.optional(),
      temperature: rangeSchema.optional(),
      spo2: rangeSchema.optional(),
    })
    .nullable(),
});

export const allergyListSchema: z.ZodType<AllergyList> = z.object({
  patientId: z.string(),
  tenantId: z.string(),
  status: z.enum(['unknown', 'none', 'listed']),
  items: z.array(
    z.object({
      substance: z.string(),
      reaction: z.string().optional(),
      severity: z.enum(SEVERITIES),
    }),
  ),
  version: z.number().int().min(0),
  updatedAt: z.string().optional(),
  updatedByName: z.string().optional(),
});

/** Below the low limit, above the high one, or neither. A limit that is absent is not checked. */
export type Flag = 'low' | 'high';

export function flagOf(value: number | undefined, range: VitalRange | undefined): Flag | undefined {
  if (value === undefined || !range) return undefined;
  if (range.low !== undefined && value < range.low) return 'low';
  if (range.high !== undefined && value > range.high) return 'high';
  return undefined;
}

/** Body mass index to one decimal, for show only: never stored, never sent. */
export function bmiOf(weight: number | undefined, height: number | undefined) {
  if (weight === undefined || height === undefined) return undefined;
  const metres = height / 100;
  return Math.round((weight / (metres * metres)) * 10) / 10;
}

// The vitals form. Fields hold what was typed; `toVitalsCreate` turns it into numbers.

const WHOLE = /^\d{1,3}$/;
// A point before the decimal, as the API takes it; "37,5" is refused, not read as 375.
const ONE_DECIMAL = /^\d{1,3}(\.\d)?$/;
const number = (text: string) => (text === '' ? undefined : Number(text));

/**
 * A measurement as typed: empty, or a number of the right form between the limits the API
 * takes. These are what a body can be, not what is normal: the ranges say that.
 */
function measure(min: number, max: number, decimals: boolean, message: string) {
  return z
    .string()
    .trim()
    .refine((text) => text === '' || (decimals ? ONE_DECIMAL : WHOLE).test(text), message)
    .refine((text) => {
      const value = number(text);
      return value === undefined || (value >= min && value <= max);
    }, message);
}

const vitalsFields = z.object({
  systolic: measure(40, 300, false, 'triage:form.errors.systolic'),
  diastolic: measure(20, 200, false, 'triage:form.errors.diastolic'),
  pulse: measure(20, 300, false, 'triage:form.errors.pulse'),
  temperature: measure(25, 45, true, 'triage:form.errors.temperature'),
  spo2: measure(50, 100, false, 'triage:form.errors.spo2'),
  weight: measure(0.3, 400, true, 'triage:form.errors.weight'),
  height: measure(20, 250, true, 'triage:form.errors.height'),
  chiefComplaint: z
    .string()
    .trim()
    .max(COMPLAINT_MAX, 'validation.too_big')
    .regex(PLAIN_LINES, 'validation.plain_text'),
  correctionReason: z
    .string()
    .trim()
    .max(REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type VitalsValues = z.infer<typeof vitalsFields>;

export const blankVitals: VitalsValues = {
  systolic: '',
  diastolic: '',
  pulse: '',
  temperature: '',
  spo2: '',
  weight: '',
  height: '',
  chiefComplaint: '',
  correctionReason: '',
};

/** The form for a new reading, or for one that corrects another (which needs a reason). */
export function vitalsFormSchema(correcting: boolean) {
  return vitalsFields.superRefine((values, context) => {
    const issue = (path: keyof VitalsValues, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (MEASURES.every((name) => values[name] === '') && values.chiefComplaint === '') {
      issue('systolic', 'triage:form.errors.empty');
    }
    const systolic = number(values.systolic);
    const diastolic = number(values.diastolic);
    if ((systolic === undefined) !== (diastolic === undefined)) {
      issue(systolic === undefined ? 'systolic' : 'diastolic', 'triage:form.errors.pressurePair');
    } else if (systolic !== undefined && diastolic !== undefined && diastolic >= systolic) {
      issue('diastolic', 'triage:form.errors.pressureOrder');
    }
    if (correcting && values.correctionReason === '') {
      issue('correctionReason', 'validation.required');
    }
  });
}

/** What the form holds as the reading the API takes. Empty measurements are left out. */
export function toVitalsCreate(
  values: VitalsValues,
  { queueTokenId, correctsId }: { queueTokenId?: string; correctsId?: string },
): VitalsCreate {
  const body: VitalsCreate = {};
  for (const name of MEASURES) {
    const value = number(values[name]);
    if (value !== undefined) body[name] = value;
  }
  if (values.chiefComplaint) body.chiefComplaint = values.chiefComplaint;
  if (queueTokenId) body.queueTokenId = queueTokenId;
  if (correctsId) {
    body.correctsId = correctsId;
    body.correctionReason = values.correctionReason;
  }
  return body;
}

/** A saved reading as the form, to start a correction from. */
export function toVitalsValues(reading: Vitals): VitalsValues {
  const text = (value: number | undefined) => (value === undefined ? '' : String(value));
  return {
    systolic: text(reading.systolic),
    diastolic: text(reading.diastolic),
    pulse: text(reading.pulse),
    temperature: text(reading.temperature),
    spo2: text(reading.spo2),
    weight: text(reading.weight),
    height: text(reading.height),
    chiefComplaint: reading.chiefComplaint ?? '',
    correctionReason: '',
  };
}

// The allergies form.

const allergyRowSchema = z.object({
  substance: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(SUBSTANCE_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  reaction: z
    .string()
    .trim()
    .max(REACTION_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  severity: z.enum(SEVERITIES),
});
export type AllergyRowValues = z.infer<typeof allergyRowSchema>;

export const blankAllergy: AllergyRowValues = { substance: '', reaction: '', severity: 'unknown' };

/**
 * The rows are checked only while the status is "has allergies": rows left over from before
 * choosing "No known allergies" are not sent, so they never stop a save.
 */
export const allergiesFormSchema = z
  .object({
    status: z.enum(['none', 'listed', '']),
    rows: z
      .array(
        z.object({ substance: z.string(), reaction: z.string(), severity: z.enum(SEVERITIES) }),
      )
      .max(ALLERGIES_MAX),
  })
  .superRefine(({ status, rows }, context) => {
    if (status === '') {
      context.addIssue({ code: 'custom', path: ['status'], message: 'validation.required' });
      return;
    }
    if (status !== 'listed') return;
    if (rows.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'triage:allergies.errors.noRows',
      });
    }
    rows.forEach((row, index) => {
      const checked = allergyRowSchema.safeParse(row);
      for (const issue of checked.success ? [] : checked.error.issues) {
        context.addIssue({
          code: 'custom',
          path: ['rows', index, ...issue.path],
          message: issue.message,
        });
      }
    });
  });
export type AllergiesValues = z.infer<typeof allergiesFormSchema>;

export function toAllergiesValues(list: AllergyList): AllergiesValues {
  return {
    status: list.status === 'unknown' ? '' : list.status,
    rows: list.items.map((item) => ({
      substance: item.substance,
      reaction: item.reaction ?? '',
      severity: item.severity,
    })),
  };
}

/** The form as the API takes it: "no known allergies" sends no rows. */
export function toAllergyListUpdate(values: AllergiesValues, version: number): AllergyListUpdate {
  const status = values.status === 'listed' ? 'listed' : 'none';
  return {
    version,
    status,
    items:
      status === 'none'
        ? []
        : values.rows.map((row) => ({
            substance: row.substance,
            ...(row.reaction ? { reaction: row.reaction } : {}),
            severity: row.severity,
          })),
  };
}
