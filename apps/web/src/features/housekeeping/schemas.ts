import { z } from 'zod';
import type { CleaningKind, CleaningTask, CleaningTaskPage, CleaningTaskStatus } from './types';

export const TASK_STATUSES = [
  'open',
  'in_progress',
  'done',
  'cancelled',
] as const satisfies readonly CleaningTaskStatus[];
export const TASK_KINDS = ['discharge', 'routine'] as const satisfies readonly CleaningKind[];

/** The moves a person may make from a status, as the server's table allows them. */
export function allowedMoves(status: CleaningTaskStatus) {
  return {
    start: status === 'open',
    finish: status === 'in_progress',
    cancel: status === 'open' || status === 'in_progress',
  };
}

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const cleaningTaskSchema: z.ZodType<CleaningTask> = z.object({
  id: z.string(),
  tenantId: z.string(),
  bedId: z.string(),
  bedNumber: z.string(),
  wardId: z.string(),
  wardName: z.string(),
  kind: z.enum(TASK_KINDS),
  status: z.enum(TASK_STATUSES),
  assignedTo: z.string().optional(),
  assignedToName: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  version: z.number().int().min(1),
});

export const taskPageSchema: z.ZodType<CleaningTaskPage> = z.object({
  items: z.array(cleaningTaskSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
