import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  ChecklistEntry,
  ChecklistStepCode,
  FitnessStatus,
  AnaesthesiaInput,
  OtRoom,
  OtRoomPage,
  OperationRecord,
  PeriopRecord,
  RecoveryRecord,
  SurgeryConsumable,
  SurgeryConsumablePage,
  Surgery,
  SurgeryPage,
  SurgeryStatus,
} from './types';

export const PAGE_SIZE = 100;
export const STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
] as const satisfies readonly SurgeryStatus[];

/** The moves a person may make from a status, as the server's table allows them. */
export function allowedMoves(status: SurgeryStatus) {
  return {
    reschedule: status === 'scheduled',
    cancel: status === 'scheduled',
    start: status === 'scheduled',
    complete: status === 'in_progress',
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const when = {
  day: z.string().regex(DAY, 'validation.required'),
  startTime: z.string().regex(TIME, 'validation.required'),
  endTime: z.string().regex(TIME, 'validation.required'),
};
/** Ends after it starts on the same day. */
const ordered = (value: { startTime: string; endTime: string }) => value.endTime > value.startTime;
const orderedIssue = { message: 'validation.end_after_start', path: ['endTime'] };

export const bookFormSchema = z
  .object({
    roomId: z.string().min(1, 'validation.required'),
    surgeonId: z.string().min(1, 'validation.required'),
    procedure: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(200, 'validation.invalid_value')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    notes: z
      .string()
      .trim()
      .max(500, 'validation.invalid_value')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    ...when,
  })
  .refine(ordered, orderedIssue);
export type BookFormValues = z.infer<typeof bookFormSchema>;

export const rescheduleFormSchema = z
  .object({
    roomId: z.string().min(1, 'validation.required'),
    surgeonId: z.string().min(1, 'validation.required'),
    ...when,
  })
  .refine(ordered, orderedIssue);
export type RescheduleFormValues = z.infer<typeof rescheduleFormSchema>;

export const reasonFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(300, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type ReasonFormValues = z.infer<typeof reasonFormSchema>;

export const roomFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(80, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type RoomFormValues = z.infer<typeof roomFormSchema>;

export const roomSchema: z.ZodType<OtRoom> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  archived: z.boolean(),
  version: z.number().int().min(1),
});
export const roomPageSchema: z.ZodType<OtRoomPage> = z.object({
  items: z.array(roomSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const surgerySchema: z.ZodType<Surgery> = z.object({
  id: z.string(),
  tenantId: z.string(),
  roomId: z.string(),
  surgeonId: z.string(),
  patientId: z.string(),
  serviceId: z.string().optional(),
  encounterId: z.string().optional(),
  procedure: z.string(),
  notes: z.string().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(STATUSES),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  version: z.number().int().min(1),
});
export const surgeryPageSchema: z.ZodType<SurgeryPage> = z.object({
  items: z.array(surgerySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/**
 * The checklist as phases in the order they are done: the hospital's pre-operative steps, then
 * the three pauses of the WHO surgical safety checklist. A step of a phase waits for every step
 * of the phases before it (the server refuses otherwise; this only decides what is offered).
 */
export const CHECKLIST_PHASES = [
  { phase: 'preop', steps: ['consent_confirmed', 'site_marked', 'fasting_confirmed'] },
  {
    phase: 'sign_in',
    steps: ['identity_confirmed', 'anaesthesia_check_done', 'allergies_checked'],
  },
  { phase: 'time_out', steps: ['team_introduced', 'procedure_confirmed', 'antibiotic_given'] },
  { phase: 'sign_out', steps: ['counts_correct', 'specimens_labelled', 'concerns_handed_over'] },
] as const satisfies readonly { phase: string; steps: readonly ChecklistStepCode[] }[];

/** True when every step of the phases before this one is done. */
export function phaseOpen(phaseIndex: number, done: ReadonlySet<ChecklistStepCode>): boolean {
  return CHECKLIST_PHASES.slice(0, phaseIndex).every((p) => p.steps.every((s) => done.has(s)));
}

export const FITNESS = ['fit', 'conditional', 'unfit'] as const satisfies readonly FitnessStatus[];
export const TECHNIQUES = [
  'general',
  'spinal',
  'epidural',
  'regional',
  'local',
  'sedation',
] as const satisfies readonly AnaesthesiaInput['technique'][];
export const ASA_CLASSES = ['1', '2', '3', '4', '5', '6'] as const;

export const fitnessFormSchema = z.object({
  status: z.enum(FITNESS, { message: 'validation.required' }),
  notes: z
    .string()
    .trim()
    .max(500, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type FitnessFormValues = z.infer<typeof fitnessFormSchema>;

export const anaesthesiaFormSchema = z.object({
  technique: z.enum(TECHNIQUES, { message: 'validation.required' }),
  asaClass: z.enum(ASA_CLASSES, { message: 'validation.required' }),
  drugs: z
    .string()
    .trim()
    .max(1000, 'validation.invalid_value')
    .regex(PLAIN_LINES, 'validation.plain_text'),
  notes: z
    .string()
    .trim()
    .max(1000, 'validation.invalid_value')
    .regex(PLAIN_LINES, 'validation.plain_text'),
});
export type AnaesthesiaFormValues = z.infer<typeof anaesthesiaFormSchema>;

const entrySchema: z.ZodType<ChecklistEntry> = z.object({
  step: z.enum(
    CHECKLIST_PHASES.flatMap((p) => p.steps) as [ChecklistStepCode, ...ChecklistStepCode[]],
  ),
  completedAt: z.string(),
  completedBy: z.string(),
  completedByName: z.string(),
  note: z.string().optional(),
});
export const periopSchema: z.ZodType<PeriopRecord> = z.object({
  surgeryId: z.string(),
  checklist: z.array(entrySchema),
  fitness: z
    .object({
      status: z.enum(FITNESS),
      notes: z.string().optional(),
      assessedAt: z.string(),
      assessedBy: z.string(),
      assessedByName: z.string(),
    })
    .nullable(),
  anaesthesia: z
    .object({
      technique: z.enum(TECHNIQUES),
      asaClass: z.number().int().min(1).max(6),
      drugs: z.string().optional(),
      notes: z.string().optional(),
      savedAt: z.string(),
      signedAt: z.string().optional(),
      signedBy: z.string().optional(),
      signedByName: z.string().optional(),
    })
    .nullable(),
});

export const NOTE_TEXT_MAX = 2000;
const lines = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'validation.invalid_value')
    .regex(PLAIN_LINES, 'validation.plain_text');

export const operationNoteFormSchema = z.object({
  procedureDone: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(300, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  findings: lines(2000),
  technique: lines(2000),
  complications: lines(1000),
  bloodLossMl: z
    .string()
    .trim()
    .regex(/^(\d{1,5})?$/, 'validation.invalid_value')
    .refine((value) => value === '' || Number(value) <= 20000, 'validation.invalid_value'),
  specimens: lines(500),
  postOpPlan: lines(1000),
});
export type OperationNoteFormValues = z.infer<typeof operationNoteFormSchema>;

export const addendumFormSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(2000, 'validation.invalid_value')
    .regex(PLAIN_LINES, 'validation.plain_text'),
});
export type AddendumFormValues = z.infer<typeof addendumFormSchema>;

export const consumableFormSchema = z.object({
  locationId: z.string().min(1, 'validation.required'),
  batchId: z.string().min(1, 'validation.required'),
  quantity: z
    .string()
    .trim()
    .regex(/^[1-9]\d{0,4}$/, 'validation.invalid_value'),
});
export type ConsumableFormValues = z.infer<typeof consumableFormSchema>;

const noteSchema = z.object({
  procedureDone: z.string(),
  findings: z.string().optional(),
  technique: z.string().optional(),
  complications: z.string().optional(),
  bloodLossMl: z.number().int().optional(),
  specimens: z.string().optional(),
  postOpPlan: z.string().optional(),
  savedAt: z.string(),
  savedBy: z.string(),
  signedAt: z.string().optional(),
  signedBy: z.string().optional(),
  signedByName: z.string().optional(),
});
export const operationSchema: z.ZodType<OperationRecord> = z.object({
  surgeryId: z.string(),
  encounterId: z.string().nullable(),
  note: noteSchema.nullable(),
  addenda: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      addedBy: z.string(),
      addedByName: z.string(),
      addedAt: z.string(),
    }),
  ),
});

const consumableSchema: z.ZodType<SurgeryConsumable> = z.object({
  id: z.string(),
  useId: z.string(),
  drugId: z.string(),
  batchId: z.string(),
  locationId: z.string(),
  quantity: z.number().int(),
  returnedQuantity: z.number().int(),
  ledgerEntryId: z.string(),
  itemName: z.string(),
  batchNumber: z.string(),
  locationName: z.string(),
  recordedBy: z.string(),
  recordedAt: z.string(),
});
export const consumablePageSchema: z.ZodType<SurgeryConsumablePage> = z.object({
  items: z.array(consumableSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const visitFormSchema = z.object({
  encounterId: z.string().min(1, 'validation.required'),
});
export type VisitFormValues = z.infer<typeof visitFormSchema>;

export const returnFormSchema = z.object({
  quantity: z
    .string()
    .trim()
    .regex(/^[1-9]\d{0,4}$/, 'validation.invalid_value'),
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(300, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type ReturnFormValues = z.infer<typeof returnFormSchema>;

export const RECOVERY_READINESS = ['in_recovery', 'ready_for_ward'] as const;

export const recoverySchema: z.ZodType<RecoveryRecord> = z.object({
  surgeryId: z.string(),
  encounterId: z.string().nullable(),
  notes: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      painScore: z.number().int().nullable(),
      readiness: z.enum(RECOVERY_READINESS),
      addedBy: z.string(),
      addedByName: z.string(),
      addedAt: z.string(),
    }),
  ),
});

export const recoveryFormSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(2000, 'validation.invalid_value')
    .regex(PLAIN_LINES, 'validation.plain_text'),
  painScore: z
    .string()
    .trim()
    .regex(/^(\d|10)?$/, 'validation.invalid_value'),
  readiness: z.enum(RECOVERY_READINESS),
});
export type RecoveryFormValues = z.infer<typeof recoveryFormSchema>;
