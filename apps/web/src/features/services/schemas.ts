import { z } from 'zod';
import type { Service, ServicePage, ServicePrice, ServicePricePage } from './types';

export const CATEGORIES = [
  'consultation',
  'procedure',
  'bed',
  'lab',
  'imaging',
  'package',
] as const;
export const TAX_CLASSES = ['exempt', 'reduced', 'standard', 'higher'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const servicePriceSchema: z.ZodType<ServicePrice> = z.object({
  id: z.string(),
  serviceId: z.string(),
  priceListId: z.string(),
  amountMinor: z.number().int().min(0),
  effectiveFrom: z.string().regex(DATE),
  effectiveTo: z.string().regex(DATE).optional(),
});

export const serviceSchema: z.ZodType<Service> = z.object({
  id: z.string(),
  tenantId: z.string(),
  code: z.string(),
  name: z.string(),
  category: z.enum(CATEGORIES),
  taxClass: z.enum(TAX_CLASSES),
  description: z.string().optional(),
  archived: z.boolean(),
  version: z.number().int().min(1),
  currentPrice: servicePriceSchema.optional(),
});

const page = <Item extends z.ZodType>(item: Item) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

export const servicePageSchema: z.ZodType<ServicePage> = page(serviceSchema);
export const servicePricePageSchema: z.ZodType<ServicePricePage> = page(servicePriceSchema);

export const CODE_MAX = 30;
export const NAME_MAX = 150;
export const DESCRIPTION_MAX = 500;
/** The largest amount the API takes, in minor units. */
const AMOUNT_MAX = 1_000_000_000_000;

/** How many decimals a currency is written with: 2 for INR, 0 for JPY, 3 for KWD. */
export function currencyDigits(currency: string | undefined): number {
  if (!currency) return 2;
  try {
    const { maximumFractionDigits } = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions();
    return maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * An amount as typed ("1250", "1250.5", "1,250.50", "1,25,000") in minor units, or null when it
 * is not an amount in that currency: no sign, a point for the decimals, and no more of them than
 * the currency has. A comma is accepted only where grouping puts one (the last group before the
 * decimals is three digits, the ones before it two or three), so "12,50", typed by someone who
 * writes decimals with a comma, is refused and never read as 1250. Worked out on the digits
 * themselves, never through a floating-point number.
 */
export function toMinor(text: string, digits: number): number | null {
  const match = /^(\d[\d,]*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) return null;
  const [, grouped = '', fraction = ''] = match;
  if (grouped.includes(',') && !/^\d{1,3}(,\d{2,3})*,\d{3}$/.test(grouped)) return null;
  const whole = grouped.replace(/,/g, '');
  if (whole.length > 12 || fraction.length > digits) return null;
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) && minor <= AMOUNT_MAX ? minor : null;
}

/** The day after a YYYY-MM-DD calendar date. */
export function dayAfter(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Today as a YYYY-MM-DD calendar date at the hospital, whatever the clock of this computer is set
 * to. Built on `Intl`, as the patients feature does, to keep a date library out of this chunk.
 */
export function todayIn(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const details = {
  name: z.string().trim().min(1, 'validation.required').max(NAME_MAX),
  category: z.enum(CATEGORIES, 'validation.required'),
  taxClass: z.enum(TAX_CLASSES, 'validation.required'),
  description: z.string().trim().max(DESCRIPTION_MAX),
};

/** Changing a service. The code is not here: it never changes. */
export const serviceFormSchema = z.object(details);
export type ServiceFormValues = z.infer<typeof serviceFormSchema>;
export type ServiceField = keyof ServiceFormValues;

/** Adding a service, for a currency with that many decimals. Messages are translation keys. */
export const createServiceFormSchema = (digits: number) =>
  z.object({
    code: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(CODE_MAX)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'validation.invalid_format'),
    ...details,
    // Optional: a service may be set up first and priced later.
    price: z
      .string()
      .trim()
      .refine((text) => text === '' || toMinor(text, digits) !== null, 'validation.invalid_format'),
  });
export type CreateServiceFormValues = z.infer<ReturnType<typeof createServiceFormSchema>>;

/** A new price, from `earliest` (a YYYY-MM-DD date at the hospital) or later. */
export const createPriceFormSchema = (digits: number, earliest: string) =>
  z.object({
    amount: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toMinor(text, digits) !== null, 'validation.invalid_format'),
    effectiveFrom: z
      .string()
      .regex(DATE, 'validation.required')
      .refine((value) => value >= earliest, 'validation.date_too_early'),
  });
export type PriceFormValues = z.infer<ReturnType<typeof createPriceFormSchema>>;
