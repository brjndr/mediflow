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

/** The server's rule is 12 characters and nothing too obvious; it judges the second part. */
export const MIN_PASSWORD_LENGTH = 12;

export const setPasswordSchema = z
  .object({
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, 'account.passwordTooShort')
      .max(1024, 'validation.too_big'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'account.passwordMismatch',
  });

export type SetPasswordValues = z.output<typeof setPasswordSchema>;

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(254, 'validation.too_big')
    .pipe(z.email('validation.invalid_format')),
});

export type ForgotPasswordValues = z.output<typeof forgotPasswordSchema>;

/** For the invite of someone who already has an account: nothing to fill in. */
export const confirmSchema = z.object({});

/** An authenticator code (6 digits) or a recovery code. The server judges which and if valid. */
export const mfaCodeSchema = z.object({
  code: z.string().trim().min(1, 'validation.required').max(64, 'validation.too_big'),
});

export type MfaCodeValues = z.output<typeof mfaCodeSchema>;

/** Setting up an authenticator re-asks for the password; the server judges it. */
export const mfaPasswordSchema = z.object({
  password: z.string().min(1, 'validation.required').max(1024, 'validation.too_big'),
});

export type MfaPasswordValues = z.output<typeof mfaPasswordSchema>;
