import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import {
  BLOOD_COMPONENTS,
  BLOOD_GROUPS,
  bloodUnitSchema,
  REACTION_SEVERITIES,
  REASON_MAX,
  UNIT_NUMBER_MAX,
} from './schemas';
import type { BloodCollection, BloodDonor, BloodDonorPage, BloodDonorTrace } from './types';

// Donors, collections and the patient's blood group (#586, part 2).

export const DONOR_SEXES = ['female', 'male', 'other'] as const;
export const DONOR_MIN_AGE = 18;
export const DONOR_MAX_AGE = 65;
export const NAME_MAX = 100;
export const PHONE_MIN = 4;
export const PHONE_MAX = 20;
export const DONOR_PAGE_SIZE = 50;

export const bloodCollectionSchema: z.ZodType<BloodCollection> = z.object({
  id: z.string(),
  donorId: z.string(),
  collectedAt: z.string(),
  volumeMl: z.number().int(),
  unitIds: z.array(z.string()),
});

const donorBase = {
  id: z.string(),
  tenantId: z.string(),
  donorNumber: z.string(),
  sex: z.enum(DONOR_SEXES),
  bloodGroup: z.enum(BLOOD_GROUPS),
  status: z.enum(['active', 'deferred']),
  deferredUntil: z.string().optional(),
  deferredPermanent: z.boolean(),
  lastDonatedAt: z.string().optional(),
  version: z.number().int().min(1),
};

export const donorPageSchema: z.ZodType<BloodDonorPage> = z.object({
  items: z.array(
    z.object({
      ...donorBase,
      maskedName: z.string(),
      maskedPhone: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const donorSchema: z.ZodType<BloodDonor> = z.object({
  ...donorBase,
  fullName: z.string(),
  dateOfBirth: z.string(),
  phone: z.string().optional(),
  deferralReason: z.string().optional(),
  collections: z.array(bloodCollectionSchema),
});

export const donorTraceSchema: z.ZodType<BloodDonorTrace> = z.object({
  donor: z.object({
    id: z.string(),
    donorNumber: z.string(),
    bloodGroup: z.enum(BLOOD_GROUPS),
    fullName: z.string().optional(),
  }),
  units: z.array(
    z.object({
      unit: bloodUnitSchema,
      collectionId: z.string().optional(),
      recipientPatientId: z.string().optional(),
      reactionCount: z.number().int(),
      worstSeverity: z.enum(REACTION_SEVERITIES).optional(),
    }),
  ),
});

/** Whole years on `today`; both are calendar days (`YYYY-MM-DD`). The server holds the same rule. */
export function ageOn(dateOfBirth: string, today: string): number {
  const [by = 0, bm = 0, bd = 0] = dateOfBirth.split('-').map(Number);
  const [ty = 0, tm = 0, td = 0] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A donor as typed. The date of birth is a calendar day, kept as one. */
export const donorFormSchema = (today: string) =>
  z.object({
    fullName: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(NAME_MAX)
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    dateOfBirth: z
      .string()
      .min(1, 'validation.required')
      .regex(DAY, 'validation.invalid_format')
      .refine((value) => value <= today, 'validation.invalid_format')
      .refine((value) => {
        const age = ageOn(value, today);
        return age >= DONOR_MIN_AGE && age <= DONOR_MAX_AGE;
      }, 'blood-bank:donor.ageRange'),
    sex: z.enum(DONOR_SEXES),
    bloodGroup: z.enum(BLOOD_GROUPS),
    phone: z
      .string()
      .trim()
      .max(PHONE_MAX)
      .refine((value) => value === '' || value.length >= PHONE_MIN, 'validation.invalid_format')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  });
export type DonorFormValues = z.infer<ReturnType<typeof donorFormSchema>>;

const digits = z
  .string()
  .trim()
  .min(1, 'validation.required')
  .regex(/^[0-9]+$/, 'validation.invalid_format');

/** Most units one collection can make; the API refuses more. */
export const COLLECTION_UNITS_MAX = 4;

const collectionUnitSchema = z.object({
  unitNumber: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(UNIT_NUMBER_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  component: z.enum(BLOOD_COMPONENTS),
  unitVolumeMl: digits.refine(
    (value) => Number(value) >= 10 && Number(value) <= 1000,
    'validation.invalid_format',
  ),
  expiresAt: z.string().min(1, 'validation.required'),
});

/** A collection with the one to four units made of it. The times are the hospital's clock. */
export const collectionFormSchema = z
  .object({
    collectedAt: z.string().min(1, 'validation.required'),
    volumeMl: digits.refine(
      (value) => Number(value) >= 50 && Number(value) <= 1000,
      'validation.invalid_format',
    ),
    units: z.array(collectionUnitSchema).min(1).max(COLLECTION_UNITS_MAX),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.units.forEach((unit, index) => {
      if (unit.expiresAt && unit.expiresAt <= value.collectedAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'expiresAt'],
          message: 'validation.invalid_format',
        });
      }
      const number = unit.unitNumber.trim();
      if (number && seen.has(number)) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'unitNumber'],
          message: 'blood-bank:collection.duplicateNumber',
        });
      }
      seen.add(number);
    });
  });
export type CollectionFormValues = z.infer<typeof collectionFormSchema>;

/** A deferral: until a day (the start of that day at the hospital) or for good. */
export const deferFormSchema = (today: string) =>
  z
    .object({
      kind: z.enum(['until', 'permanent']),
      until: z.string(),
      reason: z
        .string()
        .trim()
        .min(1, 'validation.required')
        .max(REASON_MAX)
        .regex(PLAIN_TEXT, 'validation.plain_text'),
    })
    .superRefine((value, ctx) => {
      if (value.kind !== 'until') return;
      if (!DAY.test(value.until)) {
        ctx.addIssue({ code: 'custom', path: ['until'], message: 'validation.required' });
      } else if (value.until <= today) {
        ctx.addIssue({ code: 'custom', path: ['until'], message: 'validation.invalid_format' });
      }
    });
export type DeferFormValues = z.infer<ReturnType<typeof deferFormSchema>>;

/** The group written on a patient. A different group than the one on record needs a reason. */
export const patientGroupFormSchema = z.object({
  bloodGroup: z.enum(BLOOD_GROUPS, 'validation.required'),
  reason: z.string().trim().max(REASON_MAX).regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type PatientGroupFormValues = z.infer<typeof patientGroupFormSchema>;
