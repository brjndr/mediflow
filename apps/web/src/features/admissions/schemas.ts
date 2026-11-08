import { z } from 'zod';
import type {
  Admission,
  AdmissionPage,
  AdmissionType,
  BoardBed,
  BoardBedPage,
  BoardBedStatus,
} from './types';

export const BOARD_STATUSES = [
  'available',
  'occupied',
  'cleaning',
  'blocked',
] as const satisfies readonly BoardBedStatus[];

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
});
export type AdmitValues = z.infer<typeof admitSchema>;
