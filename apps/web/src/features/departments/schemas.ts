import { z } from 'zod';
import type { Department, DepartmentPage } from './types';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const departmentSchema: z.ZodType<Department> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

export const departmentPageSchema: z.ZodType<DepartmentPage> = z.object({
  items: z.array(departmentSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;

/** The add and edit form. Messages are translation keys in core `common`. */
export const departmentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(NAME_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  description: z.string().trim().max(DESCRIPTION_MAX).regex(PLAIN_LINES, 'validation.plain_text'),
});
export type DepartmentFormValues = z.infer<typeof departmentFormSchema>;
