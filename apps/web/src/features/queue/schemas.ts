import { z } from 'zod';
import type { QueuePriority, QueueToken, QueueTokenPage, QueueTokenStatus } from './types';

export const QUEUE_STATUSES = [
  'waiting',
  'called',
  'served',
  'skipped',
] as const satisfies readonly QueueTokenStatus[];

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

/** What a token's status allows on the board. The API enforces the same (409 otherwise). */
export function allowedActions(status: QueueTokenStatus) {
  return {
    callAgain: status === 'called',
    skip: status === 'called',
    recall: status === 'skipped',
    priority: status === 'waiting' || status === 'skipped',
  };
}
