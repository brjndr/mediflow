import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type { RoleDetail, RoleList } from './types';

const grantSchema = z.object({
  permission: z.string(),
  scope: z.enum(['all', 'own', 'department']).optional(),
});

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const roleListSchema: z.ZodType<RoleList> = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      builtIn: z.boolean(),
      permissionCount: z.number().int(),
      memberCount: z.number().int(),
    }),
  ),
});

export const roleDetailSchema: z.ZodType<RoleDetail> = z.object({
  id: z.string(),
  name: z.string(),
  builtIn: z.boolean(),
  memberCount: z.number().int(),
  permissions: z.array(grantSchema),
  updatedAt: z.string(),
});

export const NAME_MAX = 80;

/** The add and rename form. Messages are translation keys in core `common`. */
export const roleFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(NAME_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type RoleFormValues = z.infer<typeof roleFormSchema>;
