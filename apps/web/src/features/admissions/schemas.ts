import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  Admission,
  AdmissionPage,
  AdmissionType,
  BoardBed,
  BoardBedPage,
  BoardBedStatus,
  BedStay,
} from './types';

export const BOARD_STATUSES = [
  'available',
  'occupied',
  'cleaning',
  'blocked',
] as const satisfies readonly BoardBedStatus[];

/** Why a patient was given another bed, as the API lists them (an optional choice, never free text). */
export const MOVE_REASONS = [
  'clinical',
  'step_down',
  'isolation',
  'patient_request',
  'ward_closure',
  'other',
] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];
export const MOVE_NOTE_MAX = 200;

/** Why a bed is taken out of use, as the wards API lists them. A list, never free text. */
export const BLOCK_REASONS = [
  'repair',
  'maintenance',
  'deep_cleaning',
  'reserved',
  'other',
] as const;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const boardBedSchema: z.ZodType<BoardBed> = z.object({
  id: z.string(),
  number: z.string(),
  wardId: z.string(),
  wardName: z.string(),
  roomId: z.string(),
  roomName: z.string(),
  categoryName: z.string(),
  status: z.enum(BOARD_STATUSES),
  blockedReason: z.enum(BLOCK_REASONS).optional(),
  occupant: z
    .object({
      admissionId: z.string(),
      patientId: z.string(),
      patientName: z.string(),
      patientMrn: z.string(),
      assignedAt: z.string(),
    })
    .optional(),
  version: z.number().int().min(1),
});

export const boardPageSchema: z.ZodType<BoardBedPage> = z.object({
  items: z.array(boardBedSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** An event of the stream says which ward changed and nothing else. */
export const bedEventSchema = z.object({ wardId: z.string() });

export const wardOptionsSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
  nextCursor: z.string().nullish(),
});

export const blockSchema = z
  .object({ reason: z.union([z.enum(BLOCK_REASONS), z.literal('')]) })
  .superRefine((values, context) => {
    if (values.reason === '') {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'admissions:blockPanel.reasonRequired',
      });
    }
  });
export type BlockReason = (typeof BLOCK_REASONS)[number];
export type BlockValues = z.infer<typeof blockSchema>;

/** What a bed's status allows on the board. The API enforces the same (409 otherwise). */
export function allowedActions(status: BoardBedStatus) {
  return {
    markCleaning: status === 'available',
    markReady: status === 'cleaning',
    block: status === 'available',
    unblock: status === 'blocked',
  };
}

export const ADMISSION_TYPES = [
  'planned',
  'emergency',
  'transfer_in',
] as const satisfies readonly AdmissionType[];

/** As the API lists them; a list, never free text. */
export const ATTENDANT_RELATIONS = [
  'spouse',
  'parent',
  'child',
  'sibling',
  'relative',
  'friend',
  'other',
] as const;
export const ADMISSION_CONSENTS = ['admission', 'treatment', 'financial', 'privacy'] as const;
export const ADVICE_MAX = 1000;

export const admissionSchema: z.ZodType<Admission> = z.object({
  id: z.string(),
  tenantId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  encounterId: z.string(),
  doctorId: z.string(),
  doctorName: z.string(),
  departmentId: z.string(),
  departmentName: z.string(),
  admissionType: z.enum(ADMISSION_TYPES),
  status: z.enum(['admitted', 'discharged']),
  admittedAt: z.string(),
  dischargedAt: z.string().optional(),
  dischargeType: z
    .enum(['routine', 'against_advice', 'referred', 'absconded', 'deceased'])
    .optional(),
  bed: z
    .object({
      assignmentId: z.string(),
      bedId: z.string(),
      bedNumber: z.string(),
      wardId: z.string(),
      wardName: z.string(),
      roomName: z.string(),
      assignedAt: z.string(),
    })
    .optional(),
  adviceNote: z.string().optional(),
  attendantName: z.string().optional(),
  attendantRelation: z.enum(ATTENDANT_RELATIONS).optional(),
  attendantPhone: z.string().optional(),
  depositMinor: z.number().int().optional(),
  consents: z.array(z.enum(ADMISSION_CONSENTS)),
  version: z.number().int().min(1),
});

export const admissionPageSchema: z.ZodType<AdmissionPage> = z.object({
  items: z.array(admissionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** What the admit form asks for. The bed is required: the desk does not admit without one. */
export const admitSchema = z.object({
  patientId: z.string().min(1, 'admissions:admit.patientRequired'),
  admissionType: z.enum(ADMISSION_TYPES),
  doctorId: z.string(),
  bedId: z.string().min(1, 'admissions:admit.bedRequired'),
  adviceNote: z
    .string()
    .max(ADVICE_MAX, 'validation.too_big')
    .regex(PLAIN_LINES, 'validation.plain_text'),
  attendantName: z
    .string()
    .max(100, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  attendantRelation: z.union([z.enum(ATTENDANT_RELATIONS), z.literal('')]),
  attendantPhone: z
    .string()
    .max(20, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text')
    .refine((value) => value === '' || value.length >= 5, 'admissions:admit.phoneShort'),
  /** As typed; turned into minor units on submit, where the hospital's currency is known. */
  deposit: z.string().max(20, 'validation.too_big'),
  consentAdmission: z.boolean(),
  consentTreatment: z.boolean(),
  consentFinancial: z.boolean(),
  consentPrivacy: z.boolean(),
});
export type AdmitValues = z.infer<typeof admitSchema>;

export const bedStaySchema: z.ZodType<BedStay> = z.object({
  assignmentId: z.string(),
  bedId: z.string(),
  bedNumber: z.string(),
  wardId: z.string(),
  wardName: z.string(),
  bedCategoryId: z.string(),
  serviceId: z.string().optional(),
  dayPriceMinor: z.number().int().optional(),
  assignedAt: z.string(),
  moveReason: z.enum(MOVE_REASONS).optional(),
  moveNote: z.string().optional(),
  releasedAt: z.string().optional(),
  releaseReason: z.enum(['transfer', 'discharge', 'cancelled']).optional(),
});

export const admissionDetailSchema = z.object({
  admission: admissionSchema,
  stays: z.array(bedStaySchema),
});

/**
 * The days a stay is charged for: the calendar days from the one it started to the one it ended
 * (or `now`), the day of a move counting once, for the bed the patient was in at the start of it.
 * A guide on screen; the charges themselves are the billing module's.
 */
export function stayDays(stay: BedStay, now: Date, timeZone: string): number {
  const day = (iso: string | Date) => {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      numberingSystem: 'latn',
      calendar: 'gregory',
    }).formatToParts(new Date(iso));
    const part = (type: string) => Number(parts.find((each) => each.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day'));
  };
  const from = day(stay.assignedAt);
  const to = day(stay.releasedAt ?? now);
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}
