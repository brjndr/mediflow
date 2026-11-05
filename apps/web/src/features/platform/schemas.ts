import { z } from 'zod';
import { themeFromBrandColor } from '@/shared/lib/theme';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type { Hospital, HospitalPage } from './types';

/** Responses are validated where they enter the app. */
export const hospitalSchema: z.ZodType<Hospital> = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  locale: z.string(),
  timezone: z.string(),
  currency: z.string(),
  themePrimary: z.string(),
  themeLogoUrl: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  authMode: z.enum(['password', 'sso']),
  region: z.string().nullable(),
  status: z.enum(['active', 'suspended', 'offboarding']),
  maxUsers: z.number().int().nullable(),
  storageMb: z.number().int().nullable(),
  version: z.number().int(),
  memberCount: z.number().int(),
  features: z.array(z.object({ feature: z.string(), enabled: z.boolean() })),
  createdAt: z.string(),
  suspendedAt: z.string().nullable(),
  offboardingRequestedAt: z.string().nullable(),
  deleteAfter: z.string().nullable(),
});

export const hospitalPageSchema: z.ZodType<HospitalPage> = z.object({
  items: z.array(hospitalSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const HTTPS_URL = /^https:\/\/\S+$/;

/** A slug suggested from a name: lower case, words joined by single hyphens. */
export function slugFrom(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const optionalText = (max: number, lines = false) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(lines ? PLAIN_LINES : PLAIN_TEXT, 'validation.plain_text');

/** A limit is typed as text and read as a whole number; empty means no limit. */
const optionalWhole = (max: number) =>
  z
    .string()
    .trim()
    .refine((value) => value === '' || /^[1-9]\d*$/.test(value), 'platform.create.errors.whole')
    .refine((value) => value === '' || Number(value) <= max, 'platform.create.errors.whole');

export const identitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(200)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  slug: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(63)
    .regex(SLUG, 'platform.create.errors.slug'),
  registrationNumber: optionalText(100),
  address: optionalText(500, true),
  phone: optionalText(32),
  region: z.string().min(1, 'validation.required'),
});

export const localeSchema = z.object({
  locale: z
    .string()
    .trim()
    .min(2, 'validation.required')
    .max(35)
    .refine(isLocale, 'platform.create.errors.locale'),
  timezone: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(64)
    .refine(isTimezone, 'platform.create.errors.timezone'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine(
      (value) => Intl.supportedValuesOf('currency').includes(value),
      'platform.create.errors.currency',
    ),
  themePrimary: z
    .string()
    .trim()
    .regex(HEX_COLOUR, 'platform.create.errors.colour')
    // A colour the app would refuse to theme with (too light to read) is refused here, not
    // silently dropped after the hospital exists.
    .refine(
      (value) => themeFromBrandColor(value) !== null,
      'platform.create.errors.colourContrast',
    ),
  themeLogoUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => value === '' || HTTPS_URL.test(value), 'platform.create.errors.logo'),
});

export const modulesSchema = z.object({
  features: z.array(z.string()),
  maxUsers: optionalWhole(1_000_000),
  storageMb: optionalWhole(100_000_000),
});

export const hospitalFormSchema = identitySchema.and(localeSchema).and(modulesSchema);
export type HospitalFormValues = z.infer<typeof hospitalFormSchema>;

/** The request the form stands for. Empty optional fields are left out. */
export function toCreateBody(values: HospitalFormValues) {
  const text = (value: string) => (value === '' ? undefined : value);
  return {
    slug: values.slug,
    name: values.name,
    locale: values.locale,
    timezone: values.timezone,
    currency: values.currency,
    themePrimary: values.themePrimary,
    themeLogoUrl: text(values.themeLogoUrl),
    address: text(values.address),
    phone: text(values.phone),
    registrationNumber: text(values.registrationNumber),
    region: values.region,
    maxUsers: values.maxUsers === '' ? undefined : Number(values.maxUsers),
    storageMb: values.storageMb === '' ? undefined : Number(values.storageMb),
    features: values.features,
  };
}
