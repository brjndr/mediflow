import { z } from 'zod';

/**
 * Only that both fields are filled in. Whether the email is well formed or the password long
 * enough is the server's to judge, and it gives one answer for every wrong combination.
 */
export const loginSchema = z.object({
  email: z.string().trim().min(1, 'validation.required').max(254),
  password: z.string().min(1, 'validation.required').max(1024),
});

export type LoginValues = z.output<typeof loginSchema>;
