import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  CarePlan,
  CarePlanPage,
  CarePlanTask,
  FluidKind,
  FluidTotals,
  WardFluid,
  WardFluidPage,
} from './types';

export const INTAKE_KINDS = [
  'oral',
  'intravenous',
  'tube',
  'other_intake',
] as const satisfies FluidKind[];
export const OUTPUT_KINDS = [
  'urine',
  'drain',
  'vomit',
  'stool',
  'other_output',
] as const satisfies FluidKind[];
export const FLUID_KINDS = [...INTAKE_KINDS, ...OUTPUT_KINDS] as const;
export const AMOUNT_MAX = 5000;
export const REASON_MAX = 200;
export const PROBLEM_MAX = 200;
export const GOAL_MAX = 500;
export const TASK_MAX = 200;

export const isIntake = (kind: FluidKind) => (INTAKE_KINDS as readonly string[]).includes(kind);

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().optional(),
  });

export const wardFluidSchema: z.ZodType<WardFluid> = z.object({
  id: z.string(),
  tenantId: z.string(),
  admissionId: z.string(),
  direction: z.enum(['intake', 'output']),
  kind: z.enum(FLUID_KINDS),
  amountMl: z.number().int(),
  observedAt: z.string(),
  recordedAt: z.string(),
  recordedById: z.string(),
  recordedByName: z.string(),
  correctsId: z.string().optional(),
  correctionReason: z.string().optional(),
  correctedById: z.string().optional(),
});
export const wardFluidPageSchema: z.ZodType<WardFluidPage> = page(wardFluidSchema);

export const fluidTotalsSchema: z.ZodType<FluidTotals> = z.object({
  from: z.string(),
  to: z.string(),
  intakeMl: z.number().int(),
  outputMl: z.number().int(),
  balanceMl: z.number().int(),
  entries: z.number().int(),
});

const taskSchema: z.ZodType<CarePlanTask> = z.object({
  id: z.string(),
  description: z.string(),
  dueAt: z.string().optional(),
  doneAt: z.string().optional(),
  doneById: z.string().optional(),
  doneByName: z.string().optional(),
  doneNote: z.string().optional(),
});
export const carePlanSchema: z.ZodType<CarePlan> = z.object({
  id: z.string(),
  tenantId: z.string(),
  admissionId: z.string(),
  problem: z.string(),
  goal: z.string().optional(),
  status: z.enum(['active', 'completed', 'cancelled']),
  createdAt: z.string(),
  createdById: z.string(),
  createdByName: z.string(),
  closedAt: z.string().optional(),
  tasks: z.array(taskSchema),
});
export const carePlanPageSchema: z.ZodType<CarePlanPage> = page(carePlanSchema);

// --- the forms ---------------------------------------------------------------------------------

const kind = z.enum(FLUID_KINDS);
const amount = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,3}$/, 'nursing:fluids.errors.amount')
  .refine((value) => Number(value) <= AMOUNT_MAX, 'nursing:fluids.errors.amount');
const reason = z
  .string()
  .trim()
  .min(1, 'nursing:fluids.errors.reason')
  .max(REASON_MAX)
  .regex(PLAIN_TEXT, 'validation.plain_text');

export const fluidFormSchema = z.object({ kind, amount });
export type FluidValues = z.infer<typeof fluidFormSchema>;
export const fluidCorrectSchema = z.object({ kind, amount, reason });
export type FluidCorrectValues = z.infer<typeof fluidCorrectSchema>;

const text = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max).regex(PLAIN_TEXT, 'validation.plain_text');

export const planFormSchema = z.object({
  problem: text(PROBLEM_MAX, 'nursing:care.errors.problem'),
  goal: z.string().trim().max(GOAL_MAX).regex(PLAIN_TEXT, 'validation.plain_text'),
  firstTask: z.string().trim().max(TASK_MAX).regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type PlanValues = z.infer<typeof planFormSchema>;

export const taskFormSchema = z.object({
  description: text(TASK_MAX, 'nursing:care.errors.task'),
});
export type TaskValues = z.infer<typeof taskFormSchema>;
