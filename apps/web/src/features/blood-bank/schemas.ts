import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  BloodComponent,
  BloodGroup,
  BloodStock,
  BloodUnit,
  BloodUnitDetail,
  BloodUnitPage,
  BloodUnitStatus,
  BloodCrossmatch,
  BloodScreening,
  BloodUnitTrace,
  CompatibleUnits,
  PatientBloodGroup,
  ReactionKind,
  ReactionSeverity,
  ScreeningResult,
  TransfusionReaction,
} from './types';

export const BLOOD_GROUPS = [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
] as const satisfies readonly BloodGroup[];
export const BLOOD_COMPONENTS = [
  'whole_blood',
  'red_cells',
  'plasma',
  'platelets',
  'cryo',
] as const satisfies readonly BloodComponent[];
export const UNIT_STATUSES = [
  'collected',
  'testing',
  'available',
  'reserved',
  'issued',
  'transfused',
  'discarded',
  'expired',
] as const satisfies readonly BloodUnitStatus[];

export const UNIT_NUMBER_MAX = 40;
export const REASON_MAX = 500;
export const ACTIONS_MAX = 2000;

/** The moves a person may make from a status, as the server's table allows them. */
export function allowedMoves(
  unit: Pick<BloodUnit, 'status' | 'expiresAt' | 'screeningStatus'>,
  now = Date.now(),
) {
  const past = new Date(unit.expiresAt).getTime() <= now;
  const { status } = unit;
  return {
    test: status === 'collected',
    // Only a unit whose screening came back clear may go to stock (the server refuses the rest).
    screen: status === 'testing' && unit.screeningStatus === 'pending',
    clear: status === 'testing' && unit.screeningStatus === 'cleared',
    crossmatch: status === 'available' && !past,
    react: status === 'issued' || status === 'transfused',
    reserve: status === 'available' && !past,
    release: status === 'reserved',
    issue: status === 'reserved' && !past,
    transfuse: status === 'issued',
    discard: status !== 'transfused' && status !== 'discarded' && status !== 'expired',
    expire: (status === 'available' || status === 'reserved') && past,
  };
}

const unitSchema: z.ZodType<BloodUnit> = z.object({
  id: z.string(),
  tenantId: z.string(),
  unitNumber: z.string(),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(BLOOD_COMPONENTS),
  volumeMl: z.number().int(),
  collectedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(UNIT_STATUSES),
  screeningStatus: z.enum(['pending', 'cleared', 'reactive']),
  patientId: z.string().optional(),
  version: z.number().int().min(1),
});
export { unitSchema as bloodUnitSchema };

export const unitPageSchema: z.ZodType<BloodUnitPage> = z.object({
  items: z.array(unitSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const historySchema = z.array(
  z.object({
    fromStatus: z.enum(UNIT_STATUSES).optional(),
    toStatus: z.enum(UNIT_STATUSES),
    patientId: z.string().optional(),
    reason: z.string().optional(),
    actorId: z.string(),
    occurredAt: z.string(),
  }),
);

export const unitDetailSchema: z.ZodType<BloodUnitDetail> = z.object({
  unit: unitSchema,
  history: historySchema,
});

export const stockSchema: z.ZodType<BloodStock> = z.object({
  items: z.array(
    z.object({
      bloodGroup: z.enum(BLOOD_GROUPS),
      component: z.enum(BLOOD_COMPONENTS),
      available: z.number().int(),
      reserved: z.number().int(),
      nextExpiry: z.string().optional(),
    }),
  ),
});

/** A new unit, as typed: the dates are the hospital's own clock, made into instants on sending. */
export const registerFormSchema = z.object({
  unitNumber: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(UNIT_NUMBER_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(BLOOD_COMPONENTS),
  volumeMl: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .regex(/^[0-9]+$/, 'validation.invalid_format')
    .refine((value) => Number(value) >= 10 && Number(value) <= 1000, 'validation.invalid_format'),
  collectedAt: z.string().min(1, 'validation.required'),
  expiresAt: z.string().min(1, 'validation.required'),
});
export type RegisterFormValues = z.infer<typeof registerFormSchema>;

export const discardFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(REASON_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type DiscardFormValues = z.infer<typeof discardFormSchema>;

export const SCREENING_TESTS = ['hiv', 'hbv', 'hcv', 'syphilis', 'malaria'] as const;
export const SCREENING_RESULTS = [
  'negative',
  'reactive',
] as const satisfies readonly ScreeningResult[];
export const REACTION_KINDS = [
  'febrile',
  'allergic',
  'hemolytic',
  'trali',
  'taco',
  'other',
] as const satisfies readonly ReactionKind[];
export const REACTION_SEVERITIES = [
  'mild',
  'moderate',
  'severe',
] as const satisfies readonly ReactionSeverity[];

/** Higher is worse. A report can only move up this scale, as the server holds it. */
export function severityRank(severity: ReactionSeverity): number {
  return REACTION_SEVERITIES.indexOf(severity);
}

const resultSchema = z.enum(SCREENING_RESULTS);
export const screeningFormSchema = z.object({
  hiv: resultSchema,
  hbv: resultSchema,
  hcv: resultSchema,
  syphilis: resultSchema,
  malaria: resultSchema,
});
export type ScreeningFormValues = z.infer<typeof screeningFormSchema>;

export const screeningSchema: z.ZodType<BloodScreening> = z.object({
  id: z.string(),
  unitId: z.string(),
  hiv: resultSchema,
  hbv: resultSchema,
  hcv: resultSchema,
  syphilis: resultSchema,
  malaria: resultSchema,
  outcome: z.enum(['cleared', 'reactive']),
  screenedBy: z.string(),
  screenedAt: z.string(),
});

export const crossmatchSchema: z.ZodType<BloodCrossmatch> = z.object({
  id: z.string(),
  unitId: z.string(),
  patientId: z.string(),
  result: z.enum(['compatible', 'incompatible']),
  performedBy: z.string(),
  performedAt: z.string(),
  validUntil: z.string(),
});

export const crossmatchFormSchema = z.object({
  result: z.enum(['compatible', 'incompatible']),
});
export type CrossmatchFormValues = z.infer<typeof crossmatchFormSchema>;

export const compatibleUnitsSchema: z.ZodType<CompatibleUnits> = z.object({
  patientBloodGroup: z.enum(BLOOD_GROUPS).optional(),
  items: z.array(
    z.object({
      unit: unitSchema,
      crossmatch: crossmatchSchema.optional(),
      crossmatchValid: z.boolean(),
    }),
  ),
});

export const patientBloodGroupSchema: z.ZodType<PatientBloodGroup> = z.object({
  patientId: z.string(),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  history: z.array(
    z.object({
      bloodGroup: z.enum(BLOOD_GROUPS),
      reason: z.string().optional(),
      recordedBy: z.string(),
      recordedAt: z.string(),
    }),
  ),
});

const severitySchema = z.enum(REACTION_SEVERITIES);
export const reactionSchema: z.ZodType<TransfusionReaction> = z.object({
  id: z.string(),
  unitId: z.string(),
  patientId: z.string(),
  encounterId: z.string().optional(),
  transfusedAt: z.string(),
  onsetAt: z.string(),
  kind: z.enum(REACTION_KINDS),
  severity: severitySchema,
  currentSeverity: severitySchema,
  actions: z.string(),
  reportedBy: z.string(),
  createdAt: z.string(),
  updates: z.array(
    z.object({
      id: z.string(),
      note: z.string(),
      severity: severitySchema.optional(),
      recordedBy: z.string(),
      recordedAt: z.string(),
    }),
  ),
  heldUnitIds: z.array(z.string()).optional(),
});

export const traceSchema: z.ZodType<BloodUnitTrace> = z.object({
  unit: unitSchema,
  donor: z
    .object({
      id: z.string(),
      donorNumber: z.string(),
      bloodGroup: z.enum(BLOOD_GROUPS),
      fullName: z.string().optional(),
    })
    .optional(),
  collectionId: z.string().optional(),
  collectedAt: z.string().optional(),
  screeningOutcome: z.enum(['cleared', 'reactive']).optional(),
  history: historySchema,
  crossmatches: z.array(crossmatchSchema),
  recipientPatientId: z.string().optional(),
  reactions: z.array(reactionSchema),
});

/** A reaction as typed: the times are the hospital's clock, made into instants on sending. */
export const reactionFormSchema = z
  .object({
    kind: z.enum(REACTION_KINDS),
    severity: severitySchema,
    transfusedAt: z.string().min(1, 'validation.required'),
    onsetAt: z.string().min(1, 'validation.required'),
    actions: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(ACTIONS_MAX)
      .regex(PLAIN_LINES, 'validation.plain_text'),
  })
  .refine((value) => value.onsetAt >= value.transfusedAt, {
    path: ['onsetAt'],
    message: 'validation.invalid_format',
  });
export type ReactionFormValues = z.infer<typeof reactionFormSchema>;

export const reactionUpdateFormSchema = z.object({
  note: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(ACTIONS_MAX)
    .regex(PLAIN_LINES, 'validation.plain_text'),
  severity: z.enum(['', ...REACTION_SEVERITIES]),
});
export type ReactionUpdateFormValues = z.infer<typeof reactionUpdateFormSchema>;
