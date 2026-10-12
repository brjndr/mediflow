import { z } from 'zod';
import type {
  LabRange,
  LabRanges,
  LabTest,
  LabTestComponent,
  LabTestCreate,
  LabTestPage,
} from './types';

export const DEPARTMENTS = [
  'biochemistry',
  'haematology',
  'microbiology',
  'serology',
  'hormones',
  'pathology',
  'other',
] as const;
export const SAMPLE_TYPES = [
  'blood',
  'serum',
  'plasma',
  'urine',
  'stool',
  'swab',
  'sputum',
  'csf',
  'tissue',
  'other',
] as const;
export const KINDS = ['test', 'panel'] as const;
export const RESULT_TYPES = ['numeric', 'text'] as const;
export const RANGE_SEXES = ['any', 'male', 'female'] as const;
export const PATIENT_SEXES = ['male', 'female', 'other'] as const;

const componentSchema: z.ZodType<LabTestComponent> = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
});

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const labTestSchema: z.ZodType<LabTest> = z.object({
  id: z.string(),
  tenantId: z.string(),
  code: z.string(),
  name: z.string(),
  department: z.enum(DEPARTMENTS),
  kind: z.enum(KINDS),
  resultType: z.enum(RESULT_TYPES),
  unit: z.string().optional(),
  sampleType: z.enum(SAMPLE_TYPES),
  container: z.string().optional(),
  turnaroundHours: z.number().int().min(1),
  serviceId: z.string().optional(),
  serviceName: z.string().optional(),
  components: z.array(componentSchema),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

export const labTestPageSchema: z.ZodType<LabTestPage> = z.object({
  items: z.array(labTestSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const labRangeSchema: z.ZodType<LabRange> = z.object({
  sex: z.enum(RANGE_SEXES),
  ageFromDays: z.number().int().min(0),
  ageToDays: z.number().int().min(0).optional(),
  low: z.number().optional(),
  high: z.number().optional(),
  criticalLow: z.number().optional(),
  criticalHigh: z.number().optional(),
  note: z.string().optional(),
});

export const labRangesSchema: z.ZodType<LabRanges> = z.object({
  labTestId: z.string(),
  ranges: z.array(labRangeSchema),
  version: z.number().int(),
});

export const labRangeResolvedSchema = z.object({ range: labRangeSchema.optional() });

/** The laboratory services a test can be charged as: only what the picker shows. */
export const serviceOptionsSchema = z.object({
  items: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  nextCursor: z.string().nullable(),
});
export type ServiceOption = z.infer<typeof serviceOptionsSchema>['items'][number];

export const NAME_MAX = 150;
export const CODE_MAX = 30;
export const UNIT_MAX = 30;
export const CONTAINER_MAX = 50;
export const TURNAROUND_MAX = 720;
export const COMPONENTS_MAX = 60;

/** The ids of a panel's tests as the form holds them: one text, so it is one field. */
export const joinIds = (ids: readonly string[]) => ids.join(',');
export const splitIds = (text: string) => (text ? text.split(',') : []);

const sharedFields = {
  name: z.string().trim().min(1, 'validation.required').max(NAME_MAX),
  department: z.enum(DEPARTMENTS, 'validation.required'),
  unit: z.string().trim().max(UNIT_MAX),
  sampleType: z.enum(SAMPLE_TYPES, 'validation.required'),
  container: z.string().trim().max(CONTAINER_MAX),
  // Typed as text.
  turnaroundHours: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .refine(
      (text) => /^\d{1,3}$/.test(text) && Number(text) >= 1 && Number(text) <= TURNAROUND_MAX,
      'validation.invalid_format',
    ),
  serviceId: z.string(),
};

/**
 * The add and edit form. Messages are translation keys in core `common`. A single test says how
 * its result is recorded; a panel has no result of its own and needs at least one test.
 */
export const labTestFormSchema = z.discriminatedUnion('kind', [
  z.object({
    ...sharedFields,
    kind: z.literal('test'),
    resultType: z.enum(RESULT_TYPES, 'validation.required'),
    componentIds: z.string(),
  }),
  z.object({
    ...sharedFields,
    kind: z.literal('panel'),
    resultType: z.string(),
    componentIds: z.string().min(1, 'validation.required'),
  }),
]);
export type LabTestFormValues = z.infer<typeof labTestFormSchema>;
export type LabTestField = keyof LabTestFormValues;

/** The form for a new test: the same, with the code it will be known by. */
export const labTestCreateFormSchema = labTestFormSchema.and(
  z.object({
    code: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(CODE_MAX)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'validation.invalid_format'),
  }),
);
export type LabTestCreateFormValues = z.infer<typeof labTestCreateFormSchema>;

/** What the form holds for a test, or for a new one. */
export const toFormValues = (test?: LabTest) => ({
  name: test?.name ?? '',
  department: test?.department ?? '',
  kind: test?.kind ?? 'test',
  resultType: test?.resultType ?? '',
  unit: test?.unit ?? '',
  sampleType: test?.sampleType ?? '',
  container: test?.container ?? '',
  turnaroundHours: test ? String(test.turnaroundHours) : '',
  serviceId: test?.serviceId ?? '',
  componentIds: joinIds(test?.components.map((component) => component.id) ?? []),
});

/**
 * The form's values as the API takes them. A panel has no result of its own, so no result type
 * or unit; a text result has no unit; a single test has no components. An empty optional field
 * is sent as empty text, which the API reads as "none".
 */
export function toRequest(values: LabTestFormValues): Omit<LabTestCreate, 'code'> {
  const panel = values.kind === 'panel';
  const resultType = values.kind === 'panel' ? 'text' : values.resultType;
  const numeric = resultType === 'numeric';
  return {
    name: values.name,
    department: values.department,
    kind: values.kind,
    resultType,
    unit: numeric ? values.unit : '',
    sampleType: values.sampleType,
    container: values.container,
    turnaroundHours: Number(values.turnaroundHours),
    serviceId: values.serviceId,
    componentIds: panel ? splitIds(values.componentIds) : [],
  };
}

/** A new test as the API takes it: an optional field that was left empty is left out. */
export function toCreate(values: LabTestCreateFormValues): LabTestCreate {
  const { unit, container, serviceId, componentIds, ...rest } = toRequest(values);
  return {
    code: values.code,
    ...rest,
    ...(unit ? { unit } : {}),
    ...(container ? { container } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(componentIds && componentIds.length > 0 ? { componentIds } : {}),
  };
}

// Ages. A range is kept in days since birth and typed in days, months or years. A month counts
// as a twelfth of a year of 365 days, here and where a range is looked up for a patient.

export const AGE_UNITS = ['days', 'months', 'years'] as const;
export type AgeUnit = (typeof AGE_UNITS)[number];
const YEAR_DAYS = 365;
/** 150 years: the oldest age a range can name. */
export const AGE_MAX_DAYS = 54750;

/**
 * An age in days. A year is 365 days and a month a twelfth of a year, rounded to the day, so
 * 12 months are exactly one year and a range typed in months meets one typed in years with no
 * day left between them.
 */
export function toDays(value: number, unit: AgeUnit): number {
  if (unit === 'years') return value * YEAR_DAYS;
  return unit === 'months' ? Math.round((value * YEAR_DAYS) / 12) : value;
}

/** An age in days as a person would type it: in the largest unit that fits it exactly. */
export function fromDays(days: number): { value: number; unit: AgeUnit } {
  if (days > 0 && days % YEAR_DAYS === 0) return { value: days / YEAR_DAYS, unit: 'years' };
  const months = Math.round((days * 12) / YEAR_DAYS);
  if (months > 0 && toDays(months, 'months') === days) return { value: months, unit: 'months' };
  return { value: days, unit: 'days' };
}

const WHOLE = /^\d{1,5}$/;
const DECIMAL = /^-?\d{1,9}(\.\d{1,6})?$/;
const number = (text: string) => (text === '' ? undefined : Number(text));

const limit = z
  .string()
  .trim()
  .refine((text) => text === '' || DECIMAL.test(text), 'validation.invalid_format');

/**
 * One row of the ranges form. The age runs from `from` up to, and not including, `until`, so the
 * next row starts at the age the one before it ends; an empty `until` has no upper age.
 */
const rangeRowSchema = z.object({
  sex: z.enum(RANGE_SEXES),
  fromValue: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .regex(WHOLE, 'validation.invalid_format'),
  fromUnit: z.enum(AGE_UNITS),
  untilValue: z
    .string()
    .trim()
    .refine((text) => text === '' || WHOLE.test(text), 'validation.invalid_format'),
  untilUnit: z.enum(AGE_UNITS),
  low: limit,
  high: limit,
  criticalLow: limit,
  criticalHigh: limit,
  note: z.string().trim().max(150),
});
export type RangeRowValues = z.infer<typeof rangeRowSchema>;

export const blankRangeRow: RangeRowValues = {
  sex: 'any',
  fromValue: '0',
  fromUnit: 'years',
  untilValue: '',
  untilUnit: 'years',
  low: '',
  high: '',
  criticalLow: '',
  criticalHigh: '',
  note: '',
};

/** A row of the form as the range the API takes. */
export function toRange(row: RangeRowValues): LabRange {
  const until = number(row.untilValue);
  const low = number(row.low);
  const high = number(row.high);
  const criticalLow = number(row.criticalLow);
  const criticalHigh = number(row.criticalHigh);
  return {
    sex: row.sex,
    ageFromDays: toDays(Number(row.fromValue), row.fromUnit),
    // Kept as the last day covered.
    ...(until === undefined ? {} : { ageToDays: toDays(until, row.untilUnit) - 1 }),
    ...(low === undefined ? {} : { low }),
    ...(high === undefined ? {} : { high }),
    ...(criticalLow === undefined ? {} : { criticalLow }),
    ...(criticalHigh === undefined ? {} : { criticalHigh }),
    ...(row.note ? { note: row.note } : {}),
  };
}

/** A saved range as a row of the form. */
export function toRangeRow(range: LabRange): RangeRowValues {
  const from = fromDays(range.ageFromDays);
  const until = range.ageToDays === undefined ? undefined : fromDays(range.ageToDays + 1);
  const text = (value: number | undefined) => (value === undefined ? '' : String(value));
  return {
    sex: range.sex,
    fromValue: String(from.value),
    fromUnit: from.unit,
    untilValue: until ? String(until.value) : '',
    untilUnit: until?.unit ?? 'years',
    low: text(range.low),
    high: text(range.high),
    criticalLow: text(range.criticalLow),
    criticalHigh: text(range.criticalHigh),
    note: range.note ?? '',
  };
}

/** Whether two ranges for the same people cover an age in common. */
export const rangesOverlap = (a: LabRange, b: LabRange) =>
  a.sex === b.sex &&
  a.ageFromDays <= (b.ageToDays ?? Infinity) &&
  b.ageFromDays <= (a.ageToDays ?? Infinity);

/**
 * The range for a patient of an age and a sex: the row for that sex covering the age, else the
 * row for any sex. The server applies the same rule; this one orders the rows on screen.
 */
export function sortRanges(ranges: readonly LabRange[]): LabRange[] {
  const order = (sex: LabRange['sex']) => RANGE_SEXES.indexOf(sex);
  return [...ranges].sort((a, b) => a.ageFromDays - b.ageFromDays || order(a.sex) - order(b.sex));
}

/** The ranges form. The feature's own messages are keys of its namespace. */
export const rangesFormSchema = z
  .object({ rows: z.array(rangeRowSchema).max(60) })
  .superRefine(({ rows }, context) => {
    const issue = (index: number, field: keyof RangeRowValues, message: string) =>
      context.addIssue({ code: 'custom', path: ['rows', index, field], message });
    // Only rows that read as numbers are compared: the others already carry their own message.
    const ranges = rows.map((row) => (rangeRowSchema.safeParse(row).success ? toRange(row) : null));
    ranges.forEach((range, index) => {
      if (!range) return;
      const { low, high, criticalLow, criticalHigh } = range;
      if (range.ageFromDays > AGE_MAX_DAYS) issue(index, 'fromValue', 'validation.too_big');
      if (range.ageToDays !== undefined) {
        if (range.ageToDays < range.ageFromDays) {
          issue(index, 'untilValue', 'lab_tests:ranges.errors.untilAfterFrom');
        } else if (range.ageToDays > AGE_MAX_DAYS) issue(index, 'untilValue', 'validation.too_big');
      }
      if (low === undefined && high === undefined) {
        issue(index, 'low', 'lab_tests:ranges.errors.oneLimit');
      } else if (low !== undefined && high !== undefined && low >= high) {
        issue(index, 'high', 'lab_tests:ranges.errors.highAboveLow');
      }
      // A critical limit lies outside what is normal, never inside it.
      const floor = low ?? high;
      const ceiling = high ?? low;
      if (criticalLow !== undefined && floor !== undefined && criticalLow > floor) {
        issue(index, 'criticalLow', 'lab_tests:ranges.errors.criticalLow');
      }
      if (criticalHigh !== undefined && ceiling !== undefined && criticalHigh < ceiling) {
        issue(index, 'criticalHigh', 'lab_tests:ranges.errors.criticalHigh');
      }
      if (ranges.slice(0, index).some((earlier) => earlier && rangesOverlap(earlier, range))) {
        issue(index, 'fromValue', 'lab_tests:ranges.errors.overlap');
      }
    });
  });
export type RangesFormValues = z.infer<typeof rangesFormSchema>;

/** The form that asks which range applies to a patient. */
export const resolveFormSchema = z
  .object({
    ageValue: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .regex(WHOLE, 'validation.invalid_format'),
    ageUnit: z.enum(AGE_UNITS),
    sex: z.enum(PATIENT_SEXES, 'validation.required'),
  })
  .superRefine((values, context) => {
    // The age in days, whatever unit it was typed in, is what has a limit.
    if (toDays(Number(values.ageValue), values.ageUnit) > AGE_MAX_DAYS) {
      context.addIssue({ code: 'custom', path: ['ageValue'], message: 'validation.too_big' });
    }
  });
export type ResolveFormValues = z.infer<typeof resolveFormSchema>;
