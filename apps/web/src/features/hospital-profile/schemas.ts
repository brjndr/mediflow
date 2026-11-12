import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type { HospitalProfile } from './types';

export const hospitalProfileSchema: z.ZodType<HospitalProfile> = z.object({
  address: z.string().optional(),
  phone: z.string().optional(),
  registrationNumber: z.string().optional(),
  gstin: z.string().optional(),
  version: z.number().int().min(1),
});

export const ADDRESS_MAX = 300;
export const PHONE_MAX = 50;
export const REGISTRATION_MAX = 50;

/** The form. Every detail is optional; an empty one removes it. Messages are keys in `common`. */
export const profileFormSchema = z.object({
  address: z.string().trim().max(ADDRESS_MAX).regex(PLAIN_LINES, 'validation.plain_text'),
  phone: z.string().trim().max(PHONE_MAX).regex(PLAIN_TEXT, 'validation.plain_text'),
  registrationNumber: z
    .string()
    .trim()
    .max(REGISTRATION_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  // Fifteen characters, the first two digits; typed in any case, saved in capitals.
  gstin: z
    .string()
    .trim()
    .regex(/^([0-9]{2}[A-Za-z0-9]{13})?$/, 'hospital-profile:gstinInvalid'),
});
export type ProfileFormValues = z.infer<typeof profileFormSchema>;
export type ProfileField = keyof ProfileFormValues;
export const PROFILE_FIELDS: ProfileField[] = ['address', 'phone', 'registrationNumber', 'gstin'];

export const toFormValues = (profile: HospitalProfile): ProfileFormValues => ({
  address: profile.address ?? '',
  phone: profile.phone ?? '',
  registrationNumber: profile.registrationNumber ?? '',
  gstin: profile.gstin ?? '',
});
