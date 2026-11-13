import { z } from 'zod';
import { PLAIN_LINES } from '@/shared/utils/text';
import type { KitchenListPage, WardDiet, WardDietOrder } from './types';

/** The API's limit for the instructions of an order (`apps/api/src/features/clinical`). */
export const DIET_MAX = 500;
export const DIET_PRIORITIES = ['routine', 'urgent'] as const;

export const wardDietOrderSchema: z.ZodType<WardDietOrder> = z.object({
  id: z.string(),
  status: z.string(),
  priority: z.string(),
  instructions: z.string(),
  placedAt: z.string(),
});

export const wardDietSchema: z.ZodType<WardDiet> = z.object({
  items: z.array(wardDietOrderSchema),
});

export const kitchenListPageSchema: z.ZodType<KitchenListPage> = z.object({
  items: z.array(
    z.object({
      admissionId: z.string(),
      patientId: z.string(),
      patientName: z.string(),
      patientMrn: z.string(),
      wardId: z.string().optional(),
      wardName: z.string().optional(),
      roomName: z.string().optional(),
      bedNumber: z.string().optional(),
      admittedAt: z.string(),
      diet: wardDietOrderSchema.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  total: z.number().optional(),
});

/** A diet order is its instructions: what the patient may and may not eat. */
export const dietFormSchema = z.object({
  instructions: z
    .string()
    .trim()
    .min(1, 'nursing:diet.errors.instructions')
    .max(DIET_MAX, 'nursing:diet.errors.instructions')
    .regex(PLAIN_LINES, 'validation.plain_text'),
  priority: z.enum(DIET_PRIORITIES),
});
export type DietValues = z.infer<typeof dietFormSchema>;
