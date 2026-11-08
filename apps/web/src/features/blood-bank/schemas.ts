import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  BloodComponent,
  BloodGroup,
  BloodStock,
  BloodUnit,
  BloodUnitDetail,
  BloodUnitPage,
  BloodUnitStatus,
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

/** The moves a person may make from a status, as the server's table allows them. */
export function allowedMoves(unit: Pick<BloodUnit, 'status' | 'expiresAt'>, now = Date.now()) {
  const past = new Date(unit.expiresAt).getTime() <= now;
  const { status } = unit;
  return {
    test: status === 'collected',
    clear: status === 'testing',
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
  patientId: z.string().optional(),
  version: z.number().int().min(1),
});
export { unitSchema as bloodUnitSchema };

export const unitPageSchema: z.ZodType<BloodUnitPage> = z.object({
  items: z.array(unitSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const unitDetailSchema: z.ZodType<BloodUnitDetail> = z.object({
  unit: unitSchema,
  history: z.array(
    z.object({
      fromStatus: z.enum(UNIT_STATUSES).optional(),
      toStatus: z.enum(UNIT_STATUSES),
      patientId: z.string().optional(),
      reason: z.string().optional(),
      actorId: z.string(),
      occurredAt: z.string(),
    }),
  ),
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
