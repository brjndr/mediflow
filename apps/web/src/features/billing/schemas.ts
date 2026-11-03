import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type { Charge, ChargePage, Invoice, InvoicePage } from './types';

/** The API's limits (`planned.openapi.json`, until the billing API has them). */
export const DESCRIPTION_MAX = 200;
export const QUANTITY_MAX = 9999;
export const MANUAL_LINES_MAX = 50;
export const CHARGES_MAX = 200;

const SOURCES = ['service', 'order', 'dispense', 'bed', 'procedure', 'manual'] as const;

// Responses are validated where they enter the app, so screens can trust their shape.

export const chargeSchema: z.ZodType<Charge> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  source: z.enum(SOURCES),
  description: z.string(),
  quantity: z.number().int(),
  unitPriceMinor: z.number().int(),
  totalMinor: z.number().int(),
  status: z.enum(['pending', 'invoiced', 'void']),
  invoiceId: z.string().optional(),
  flag: z.enum(['service_archived', 'no_price', 'return_review']).optional(),
  postedAt: z.string(),
});

export const chargePageSchema: z.ZodType<ChargePage> = z.object({
  items: z.array(chargeSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const invoiceSchema: z.ZodType<Invoice> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  number: z.string().optional(),
  status: z.enum(['draft', 'issued', 'paid', 'void']),
  lines: z.array(
    z.object({
      id: z.string(),
      chargeId: z.string().optional(),
      source: z.enum(SOURCES),
      description: z.string(),
      quantity: z.number().int(),
      unitPriceMinor: z.number().int(),
      totalMinor: z.number().int(),
    }),
  ),
  totalMinor: z.number().int(),
  paidMinor: z.number().int(),
  creditedMinor: z.number().int(),
  currency: z.string(),
  createdAt: z.string(),
  issuedAt: z.string().optional(),
  version: z.number().int(),
});

export const invoicePageSchema: z.ZodType<InvoicePage> = z.object({
  items: z.array(invoiceSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/**
 * The form for a line typed in. The unit price stays text until the screen turns it into minor
 * units on its digits (`toMinor`), so `checkMoney` says whether the text is an amount in the
 * hospital's currency; the quantity is a whole number.
 */
export function createManualLineSchema(checkMoney: (text: string) => number | null) {
  return z.object({
    description: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(DESCRIPTION_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    quantity: z
      .string()
      .trim()
      .regex(/^\d+$/, 'billing:line.quantityWhole')
      .refine(
        (text) => Number(text) >= 1 && Number(text) <= QUANTITY_MAX,
        'billing:line.quantityRange',
      ),
    unitPrice: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => checkMoney(text) !== null, 'billing:line.priceInvalid'),
  });
}
export type ManualLineInput = z.input<ReturnType<typeof createManualLineSchema>>;
export type ManualLineValues = z.output<ReturnType<typeof createManualLineSchema>>;
