import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  ClinicalNote,
  ClinicalNotePage,
  Credentials,
  Diagnosis,
  DiagnosisCreate,
  DiagnosisKind,
  DiagnosisPage,
  Encounter,
  EncounterPage,
  EncounterStatus,
  EncounterType,
  MedicationRoute,
  Order,
  OrderCreate,
  OrderPage,
  OrderPriority,
  OrderStatus,
  Prescription,
  PrescriptionCreate,
  PrescriptionPage,
} from './types';

export const ENCOUNTER_STATUSES = [
  'open',
  'closed',
  'cancelled',
] as const satisfies readonly EncounterStatus[];
export const ENCOUNTER_TYPES = [
  'opd',
  'ipd',
  'er',
  'daycare',
] as const satisfies readonly EncounterType[];
export const DIAGNOSIS_KINDS = ['provisional', 'final'] as const satisfies readonly DiagnosisKind[];

/** The API's limits (`apps/api/src/features/clinical/schemas.ts`). */
export const REASON_MAX = 200;
export const DIAGNOSIS_TEXT_MAX = 300;

// Responses are validated where they enter the app, so screens can trust their shape.

const credentialsSchema: z.ZodType<Credentials> = z.object({
  qualifications: z.string().optional(),
  registrationNumber: z.string().optional(),
  registrationCouncil: z.string().optional(),
});

export const encounterSchema: z.ZodType<Encounter> = z.object({
  id: z.string(),
  tenantId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  type: z.enum(ENCOUNTER_TYPES),
  status: z.enum(ENCOUNTER_STATUSES),
  appointmentId: z.string().optional(),
  queueTokenId: z.string().optional(),
  attendingDoctorId: z.string().optional(),
  attendingDoctorName: z.string().optional(),
  attendingDoctorCredentials: credentialsSchema.optional(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  openedAt: z.string(),
  openedByName: z.string(),
  endedAt: z.string().optional(),
  endedByName: z.string().optional(),
  cancelReason: z.string().optional(),
  version: z.number().int(),
});

export const encounterPageSchema: z.ZodType<EncounterPage> = z.object({
  items: z.array(encounterSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const noteSchema: z.ZodType<ClinicalNote> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  status: z.enum(['draft', 'signed']),
  // The rich text document; sanitized again wherever it is shown or edited.
  body: z.record(z.string(), z.unknown()),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  signedAt: z.string().optional(),
  amendsId: z.string().optional(),
  amendmentReason: z.string().optional(),
  amendedById: z.string().optional(),
  version: z.number().int(),
});

export const notePageSchema: z.ZodType<ClinicalNotePage> = z.object({
  items: z.array(noteSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const diagnosisSchema: z.ZodType<Diagnosis> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  codeId: z.string().optional(),
  code: z.string().optional(),
  codeTitle: z.string().optional(),
  text: z.string().optional(),
  kind: z.enum(DIAGNOSIS_KINDS),
  recordedAt: z.string(),
  recordedByName: z.string(),
  retractedAt: z.string().optional(),
  retractedByName: z.string().optional(),
  retractionReason: z.string().optional(),
});

export const diagnosisPageSchema: z.ZodType<DiagnosisPage> = z.object({
  items: z.array(diagnosisSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** A reason for cancelling, amending or retracting: one line of plain text, required. */
export const reasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type ReasonValues = z.infer<typeof reasonSchema>;

/**
 * A diagnosis as typed: a code chosen from the search (its id, code and title, kept to show it),
 * words, or both. Neither is refused, as the API refuses it.
 */
export const diagnosisFormSchema = z
  .object({
    codeId: z.string(),
    text: z
      .string()
      .trim()
      .max(DIAGNOSIS_TEXT_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    kind: z.enum(DIAGNOSIS_KINDS),
  })
  .superRefine((values, context) => {
    if (values.codeId === '' && values.text === '') {
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'clinical:diagnoses.form.codeOrText',
      });
    }
  });
export type DiagnosisValues = z.input<typeof diagnosisFormSchema>;

export const blankDiagnosis: DiagnosisValues = { codeId: '', text: '', kind: 'provisional' };

export function toDiagnosisCreate(values: z.output<typeof diagnosisFormSchema>): DiagnosisCreate {
  return {
    kind: values.kind,
    ...(values.codeId ? { codeId: values.codeId } : {}),
    ...(values.text ? { text: values.text } : {}),
  };
}

/** How a diagnosis reads: its code and title as recorded, its words, or both. */
export function diagnosisName(diagnosis: Diagnosis): string {
  const coded = diagnosis.code ? `${diagnosis.code} ${diagnosis.codeTitle ?? ''}`.trim() : '';
  return [coded, diagnosis.text].filter(Boolean).join(' · ');
}

// ----- Prescriptions (#81) ----------------------------------------------------------------------

export const ORDER_STATUSES = [
  'placed',
  'accepted',
  'in_progress',
  'completed',
  'cancelled',
] as const satisfies readonly OrderStatus[];
export const MEDICATION_ROUTES = [
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
] as const satisfies readonly MedicationRoute[];

/** The API's limits for a prescription. */
export const LINES_MAX = 30;
export const DOSE_MAX = 50;
export const INSTRUCTIONS_MAX = 500;
export const ADVICE_MAX = 1000;
export const DURATION_DAYS_MAX = 365;
export const QUANTITY_MAX = 10_000;

export const orderSchema: z.ZodType<Order> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  type: z.enum(['lab', 'imaging', 'procedure', 'medication', 'diet']),
  labTestId: z.string().optional(),
  serviceId: z.string().optional(),
  drugId: z.string().optional(),
  prescriptionId: z.string().optional(),
  lineNumber: z.number().int().optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  status: z.enum(ORDER_STATUSES),
  priority: z.enum(['routine', 'urgent', 'stat']),
  instructions: z.string().optional(),
  dose: z.string().optional(),
  route: z.enum(MEDICATION_ROUTES).optional(),
  frequency: z.string().optional(),
  durationDays: z.number().int().optional(),
  quantity: z.number().int().optional(),
  placedAt: z.string(),
  orderedById: z.string(),
  orderedByName: z.string(),
  statusChangedAt: z.string().optional(),
  cancelReason: z.string().optional(),
  version: z.number().int(),
});

export const prescriptionSchema: z.ZodType<Prescription> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  prescribedAt: z.string(),
  prescribedById: z.string(),
  prescribedByName: z.string(),
  prescribedByCredentials: credentialsSchema.optional(),
  advice: z.string().optional(),
  replacesId: z.string().optional(),
  replaceReason: z.string().optional(),
  replacedById: z.string().optional(),
  lines: z.array(orderSchema),
});

export const prescriptionPageSchema: z.ZodType<PrescriptionPage> = z.object({
  items: z.array(prescriptionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** A whole number typed in a box: empty, or digits from 1 to the limit. */
const countField = (max: number, message: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) =>
        value === '' || (/^\d{1,6}$/.test(value) && Number(value) >= 1 && Number(value) <= max),
      message,
    );

/** One line as typed. The medicine is chosen from the search; its names are kept to show it. */
const lineSchema = z.object({
  drugId: z.string().min(1, 'clinical:prescriptions.form.drugRequired'),
  drugName: z.string(),
  genericName: z.string(),
  brandName: z.string(),
  dose: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(DOSE_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  route: z.enum(MEDICATION_ROUTES, 'validation.required'),
  frequency: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(DOSE_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  durationDays: countField(DURATION_DAYS_MAX, 'clinical:prescriptions.form.daysRange'),
  quantity: countField(QUANTITY_MAX, 'clinical:prescriptions.form.quantityRange'),
  instructions: z
    .string()
    .trim()
    .max(INSTRUCTIONS_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type PrescriptionLineValues = z.input<typeof lineSchema>;

/**
 * A prescription as typed: 1 to 30 lines and advice. A revision adds the reason, required; a
 * new prescription has none, as the API refuses one without `replacesId`.
 */
export const prescriptionFormSchema = (revising: boolean) =>
  z.object({
    lines: z
      .array(lineSchema)
      .min(1, 'clinical:prescriptions.form.linesRequired')
      .max(LINES_MAX, 'validation.too_big'),
    advice: z
      .string()
      .trim()
      .max(ADVICE_MAX, 'validation.too_big')
      .regex(PLAIN_LINES, 'validation.plain_text'),
    reason: revising
      ? z
          .string()
          .trim()
          .min(1, 'validation.required')
          .max(REASON_MAX, 'validation.too_big')
          .regex(PLAIN_TEXT, 'validation.plain_text')
      : z.string(),
  });
export type PrescriptionValues = z.input<ReturnType<typeof prescriptionFormSchema>>;
export type PrescriptionOutput = z.output<ReturnType<typeof prescriptionFormSchema>>;

export const blankLine: PrescriptionLineValues = {
  drugId: '',
  drugName: '',
  genericName: '',
  brandName: '',
  dose: '',
  route: 'oral',
  frequency: '',
  durationDays: '',
  quantity: '',
  instructions: '',
};

export const blankPrescription: PrescriptionValues = {
  lines: [blankLine],
  advice: '',
  reason: '',
};

/**
 * A line the revision of its prescription cancels: one not started yet. A line in progress or
 * completed stays as it is, whatever the revision says.
 */
export const replaceable = (line: Order) => line.status === 'placed' || line.status === 'accepted';

/**
 * A revision starts from the lines it would cancel, to be written again as corrected (a line
 * cancelled on its own, or already started, is not), and the advice. The names of the catalog
 * item are the ones it was ordered under.
 */
export function toPrescriptionValues(prescription: Prescription): PrescriptionValues {
  const standing = [...prescription.lines]
    .sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0))
    .filter((line) => replaceable(line) && line.drugId);
  return {
    lines: standing.map((line) => ({
      drugId: line.drugId ?? '',
      drugName: line.itemName ?? '',
      // The checks read the name as it was ordered, which holds the generic name and brand.
      genericName: line.itemName ?? '',
      brandName: '',
      dose: line.dose ?? '',
      route: line.route ?? 'oral',
      frequency: line.frequency ?? '',
      durationDays: line.durationDays === undefined ? '' : String(line.durationDays),
      quantity: line.quantity === undefined ? '' : String(line.quantity),
      instructions: line.instructions ?? '',
    })),
    advice: prescription.advice ?? '',
    reason: '',
  };
}

export function toPrescriptionCreate(
  values: PrescriptionOutput,
  replacesId?: string,
): PrescriptionCreate {
  return {
    lines: values.lines.map((line) => ({
      drugId: line.drugId,
      dose: line.dose,
      route: line.route,
      frequency: line.frequency,
      ...(line.durationDays ? { durationDays: Number(line.durationDays) } : {}),
      ...(line.quantity ? { quantity: Number(line.quantity) } : {}),
      ...(line.instructions ? { instructions: line.instructions } : {}),
    })),
    ...(values.advice ? { advice: values.advice } : {}),
    ...(replacesId ? { replacesId, replaceReason: values.reason } : {}),
  };
}

/** A prescription's lines in the order they were written. */
export const linesInOrder = (prescription: Prescription): Order[] =>
  [...prescription.lines].sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));

// ----- Lab, imaging and procedure orders (#82, #87) ----------------------------------------------

export const ORDER_PRIORITIES = [
  'routine',
  'urgent',
  'stat',
] as const satisfies readonly OrderPriority[];

export const orderPageSchema: z.ZodType<OrderPage> = z.object({
  items: z.array(orderSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** The orders the consultation places one at a time, each from its own catalog (#82, #87). */
export const ORDER_KINDS = ['lab', 'imaging', 'procedure'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/**
 * An order as typed: a test, study or procedure chosen from its search, how soon, and
 * instructions. The schema of each kind differs only in what its empty choice says.
 */
export const orderFormSchema = (kind: OrderKind) =>
  z.object({
    itemId: z.string().min(1, `clinical:${kind}Orders.form.itemRequired`),
    priority: z.enum(ORDER_PRIORITIES),
    instructions: z
      .string()
      .trim()
      .max(INSTRUCTIONS_MAX, 'validation.too_big')
      .regex(PLAIN_LINES, 'validation.plain_text'),
  });
export type OrderValues = z.input<ReturnType<typeof orderFormSchema>>;

export const blankOrder: OrderValues = {
  itemId: '',
  priority: 'routine',
  instructions: '',
};

/** A lab order names a test or panel; imaging and procedure a service of that category. */
export function toOrderCreate(
  kind: OrderKind,
  values: z.output<ReturnType<typeof orderFormSchema>>,
): OrderCreate {
  return {
    type: kind,
    ...(kind === 'lab' ? { labTestId: values.itemId } : { serviceId: values.itemId }),
    priority: values.priority,
    ...(values.instructions ? { instructions: values.instructions } : {}),
  };
}

/** The catalog item an order was placed for. */
export const orderedItemId = (order: Order) => order.labTestId ?? order.serviceId;

/** An order still in effect: not cancelled, and not yet completed. */
export const isActiveOrder = (order: Order) =>
  order.status !== 'cancelled' && order.status !== 'completed';
