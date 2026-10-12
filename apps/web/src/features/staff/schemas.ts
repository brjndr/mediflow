import { z } from 'zod';
import type { Invite, StaffMember, StaffPage, StaffRole } from './types';

export const STAFF_STATUSES = ['active', 'deactivated', 'invited'] as const;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const staffMemberSchema: z.ZodType<StaffMember> = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  roleId: z.string(),
  roleName: z.string(),
  status: z.enum(STAFF_STATUSES),
});

export const staffPageSchema: z.ZodType<StaffPage> = z.object({
  items: z.array(staffMemberSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const staffRolesSchema: z.ZodType<{ items: StaffRole[] }> = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const inviteSchema: z.ZodType<Invite> = z.object({
  id: z.string(),
  email: z.string(),
  roleId: z.string(),
  expiresInHours: z.number().int(),
});

export const sessionsRevokedSchema = z.object({ revoked: z.number().int() });

export const NAME_MAX = 200;
export const EMAIL_MAX = 254;
/** One address, as the API accepts it. */
export const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** The invite form. Messages are translation keys in core `common`. */
export const inviteFormSchema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(NAME_MAX),
  email: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(EMAIL_MAX)
    .regex(EMAIL, 'validation.invalid_format'),
  roleId: z.string().min(1, 'validation.required'),
});
export type InviteFormValues = z.infer<typeof inviteFormSchema>;
