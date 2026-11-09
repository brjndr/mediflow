import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  StayPage,
  StayRow,
  WardOption,
  WardVital,
  WardVitalCreate,
  WardVitalPage,
} from './types';

export const REASON_MAX = 200;
export const MEASURES = ['systolic', 'diastolic', 'pulse', 'temperature', 'spo2'] as const;
export type Measure = (typeof MEASURES)[number];

const flag = z.enum(['low', 'high']);

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const wardVitalSchema: z.ZodType<WardVital> = z.object({
  id: z.string(),
  tenantId: z.string(),
  admissionId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  observedAt: z.string(),
  recordedAt: z.string(),
  recordedById: z.string(),
  recordedByName: z.string(),
  systolic: z.number().optional(),
  diastolic: z.number().optional(),
  pulse: z.number().optional(),
  temperature: z.number().optional(),
  spo2: z.number().optional(),
  weight: z.number().optional(),
  height: z.number().optional(),
  flags: z
    .object({
      systolic: flag.optional(),
      diastolic: flag.optional(),
      pulse: flag.optional(),
      temperature: flag.optional(),
      spo2: flag.optional(),
    })
    .optional(),
  correctsId: z.string().optional(),
  correctionReason: z.string().optional(),
  correctedById: z.string().optional(),
});

export const wardVitalPageSchema: z.ZodType<WardVitalPage> = z.object({
  items: z.array(wardVitalSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const stayRowSchema: z.ZodType<StayRow> = z.object({
  id: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  status: z.enum(['admitted', 'discharged']),
  admittedAt: z.string(),
  doctorName: z.string(),
  bed: z.object({ bedNumber: z.string(), wardId: z.string(), wardName: z.string() }).optional(),
});

export const stayPageSchema: z.ZodType<StayPage> = z.object({
  items: z.array(stayRowSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const stayDetailSchema = z.object({ admission: stayRowSchema });

export const wardOptionsSchema: z.ZodType<{ items: WardOption[] }> = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
});

// --- the form ----------------------------------------------------------------------------------

const WHOLE = /^\d{1,3}$/;
const ONE_DECIMAL = /^\d{1,2}(\.\d)?$/;

function parse(text: string, decimal: boolean): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return (decimal ? ONE_DECIMAL : WHOLE).test(trimmed) ? Number(trimmed) : undefined;
}

/** A measurement as typed: empty, or a number of the right form between the API's limits. */
function measure(min: number, max: number, decimal: boolean, message: string) {
  return z
    .string()
    .trim()
    .refine((text) => text === '' || (decimal ? ONE_DECIMAL : WHOLE).test(text), message)
    .refine((text) => {
      const value = parse(text, decimal);
      return value === undefined || (value >= min && value <= max);
    }, message);
}

const fields = z.object({
  systolic: measure(40, 300, false, 'nursing:errors.systolic'),
  diastolic: measure(20, 200, false, 'nursing:errors.diastolic'),
  pulse: measure(20, 300, false, 'nursing:errors.pulse'),
  temperature: measure(25, 45, true, 'nursing:errors.temperature'),
  spo2: measure(50, 100, false, 'nursing:errors.spo2'),
  reason: z
    .string()
    .trim()
    .max(REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type VitalsValues = z.infer<typeof fields>;

export const blankVitals: VitalsValues = {
  systolic: '',
  diastolic: '',
  pulse: '',
  temperature: '',
  spo2: '',
  reason: '',
};

export const isDecimal = (name: Measure) => name === 'temperature';

/** The form for a new reading, or for one that corrects another (which needs a reason). */
export function vitalsFormSchema(correcting: boolean) {
  return fields.superRefine((values, context) => {
    const issue = (path: keyof VitalsValues, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (MEASURES.every((name) => values[name].trim() === '')) {
      issue('systolic', 'nursing:errors.empty');
    }
    const systolic = parse(values.systolic, false);
    const diastolic = parse(values.diastolic, false);
    if ((systolic === undefined) !== (diastolic === undefined)) {
      issue(systolic === undefined ? 'systolic' : 'diastolic', 'nursing:errors.pressurePair');
    } else if (systolic !== undefined && diastolic !== undefined && diastolic >= systolic) {
      issue('diastolic', 'nursing:errors.pressureOrder');
    }
    if (correcting && values.reason === '') issue('reason', 'validation.required');
  });
}

/** The measurements the form holds as the API takes them. Empty ones are left out. */
export function toMeasures(values: VitalsValues): WardVitalCreate {
  const body: WardVitalCreate = {};
  for (const name of MEASURES) {
    const value = parse(values[name], isDecimal(name));
    if (value !== undefined) body[name] = value;
  }
  return body;
}

/** A reading's measurements as the form shows them, to correct it. */
export function fromReading(reading: WardVital): VitalsValues {
  const text = (value: number | undefined) => (value === undefined ? '' : String(value));
  return {
    systolic: text(reading.systolic),
    diastolic: text(reading.diastolic),
    pulse: text(reading.pulse),
    temperature: text(reading.temperature),
    spo2: text(reading.spo2),
    reason: '',
  };
}
