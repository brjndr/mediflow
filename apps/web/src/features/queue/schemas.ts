import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  QueueCancelReason,
  QueuePriority,
  QueueToken,
  QueueTokenPage,
  QueueTokenStatus,
} from './types';

export const QUEUE_STATUSES = [
  'waiting',
  'called',
  'served',
  'skipped',
  'cancelled',
] as const satisfies readonly QueueTokenStatus[];

/** Why a token is taken off the queue, as the API lists them. */
export const CANCEL_REASONS = [
  'wrong_patient',
  'wrong_department',
  'left_without_being_seen',
  'other',
] as const satisfies readonly QueueCancelReason[];

export const MAX_CANCEL_NOTE = 300;

/** Why a token goes ahead of the others, as the API lists them. A fixed list for now. */
export const PRIORITIES = [
  'senior_citizen',
  'pregnancy',
  'disability',
  'child',
  'clinical_urgency',
] as const satisfies readonly QueuePriority[];

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const queueTokenSchema: z.ZodType<QueueToken> = z.object({
  id: z.string(),
  tenantId: z.string(),
  number: z.number().int().min(1),
  day: z.string(),
  departmentId: z.string(),
  departmentName: z.string(),
  doctorId: z.string().optional(),
  doctorName: z.string().optional(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  status: z.enum(QUEUE_STATUSES),
  priority: z.enum(PRIORITIES).optional(),
  issuedAt: z.string(),
  calledAt: z.string().optional(),
  callCount: z.number().int().min(0),
  cancelReason: z.enum(CANCEL_REASONS).optional(),
  version: z.number().int().min(1),
});

export const queueTokenPageSchema: z.ZodType<QueueTokenPage> = z.object({
  items: z.array(queueTokenSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** The event the stream sends when a department's queue changed: which one, never who. */
export const queueEventSchema = z.object({ departmentId: z.string() });

/** Issuing a token: the patient and the department are required, the doctor is not. */
export const issueSchema = z.object({
  patientId: z.string().min(1, 'queue:issue.patientRequired'),
  departmentId: z.string().min(1, 'queue:issue.departmentRequired'),
  doctorId: z.string(),
  priority: z.enum(PRIORITIES).or(z.literal('')),
});

export type IssueValues = z.infer<typeof issueSchema>;

/** Cancelling a token: a reason from the list, and a note that "other" needs and no other takes. */
export const cancelSchema = z
  .object({
    reason: z.union([z.enum(CANCEL_REASONS), z.literal('')]),
    note: z.string().max(MAX_CANCEL_NOTE).regex(PLAIN_TEXT, 'validation.plain_text'),
  })
  .superRefine((values, context) => {
    if (values.reason === '') {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'queue:cancelPanel.reasonRequired',
      });
    } else if (values.reason === 'other' && values.note.trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'queue:cancelPanel.noteRequired',
      });
    }
  });

export type CancelValues = z.infer<typeof cancelSchema>;

/** What a token's status allows on the board. The API enforces the same (409 otherwise). */
export function allowedActions(status: QueueTokenStatus) {
  return {
    callAgain: status === 'called',
    skip: status === 'called',
    recall: status === 'skipped',
    priority: status === 'waiting' || status === 'skipped',
    cancel: status === 'waiting' || status === 'skipped',
  };
}
