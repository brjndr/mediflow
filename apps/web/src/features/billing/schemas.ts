import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  TaxRates,
  Charge,
  ChargePage,
  CreditNote,
  Invoice,
  InvoicePage,
  Payment,
  PaymentMethod,
  RegisterSession,
  RegisterSessionPage,
} from './types';

/** The API's limits (`planned.openapi.json`, until the billing API has them). */
export const DESCRIPTION_MAX = 200;
export const QUANTITY_MAX = 9999;
export const MANUAL_LINES_MAX = 50;
export const CHARGES_MAX = 200;

const SOURCES = ['service', 'order', 'dispense', 'bed', 'procedure', 'manual'] as const;
/** The tax classes a service or a drug has; the hospital sets a rate for each. */
export const TAX_CLASSES = ['exempt', 'reduced', 'standard', 'higher'] as const;
export const RATE_MAX_BP = 10000;

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
  taxClass: z.enum(TAX_CLASSES).optional(),
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
      taxClass: z.enum(TAX_CLASSES).optional(),
      taxRateBp: z.number().int(),
      taxMinor: z.number().int(),
    }),
  ),
  totalMinor: z.number().int(),
  taxMinor: z.number().int(),
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
    // 'none' is no tax: the API takes the class left out.
    taxClass: z.enum(['none', ...TAX_CLASSES]),
  });
}
/** The form for a service charged by hand: how many. The service is chosen from the catalog. */
export const chargeQuantitySchema = z.object({
  quantity: z
    .string()
    .trim()
    .regex(/^\d+$/, 'billing:line.quantityWhole')
    .refine(
      (text) => Number(text) >= 1 && Number(text) <= QUANTITY_MAX,
      'billing:line.quantityRange',
    ),
});
export type ChargeQuantityInput = z.input<typeof chargeQuantitySchema>;
export type ChargeQuantityValues = z.output<typeof chargeQuantitySchema>;

export type ManualLineInput = z.input<ReturnType<typeof createManualLineSchema>>;
export type ManualLineValues = z.output<ReturnType<typeof createManualLineSchema>>;

export const PAYMENT_METHODS = [
  'cash',
  'card',
  'upi',
  'bank',
  'other',
] as const satisfies readonly PaymentMethod[];
export const REFERENCE_MAX = 100;

export const paymentSchema: z.ZodType<Payment> = z.object({
  id: z.string(),
  invoiceId: z.string(),
  kind: z.enum(['payment', 'refund']),
  amountMinor: z.number().int(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().optional(),
  refundOf: z.string().optional(),
  reason: z.string().optional(),
  sessionId: z.string().optional(),
  recordedByName: z.string(),
  at: z.string(),
});

export const paymentListSchema = z.object({ items: z.array(paymentSchema) });

/**
 * The form to take a payment. The amount stays text until the screen turns it into minor units on
 * its digits; `toAmount` says what the text is in minor units, or null when it is not an amount.
 * It is more than nothing and at most `dueMinor`, what is still to pay (the server decides too).
 */
export function createPaymentSchema(toAmount: (text: string) => number | null, dueMinor: number) {
  return z.object({
    amount: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toAmount(text) !== null, 'validation.invalid_format')
      .refine((text) => (toAmount(text) ?? 1) > 0, 'billing:payment.amountPositive')
      .refine((text) => (toAmount(text) ?? 0) <= dueMinor, 'billing:payment.amountTooMuch'),
    method: z.enum(PAYMENT_METHODS),
    reference: z
      .string()
      .trim()
      .max(REFERENCE_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  });
}
export type PaymentInput = z.input<ReturnType<typeof createPaymentSchema>>;
export type PaymentValues = z.output<ReturnType<typeof createPaymentSchema>>;

export const REASON_MAX = 200;

/**
 * The form to refund a payment (#444): which payment, an amount of more than nothing and at most
 * what that payment still holds (`heldOf` says, by the payment's id), and a required reason.
 */
export function createRefundSchema(
  toAmount: (text: string) => number | null,
  heldOf: (paymentId: string) => number,
) {
  return z
    .object({
      paymentId: z.string().min(1, 'validation.required'),
      amount: z
        .string()
        .trim()
        .min(1, 'validation.required')
        .refine((text) => toAmount(text) !== null, 'validation.invalid_format')
        .refine((text) => (toAmount(text) ?? 1) > 0, 'billing:refund.amountPositive'),
      reason: z
        .string()
        .trim()
        .min(1, 'validation.required')
        .max(REASON_MAX, 'validation.too_big')
        .regex(PLAIN_TEXT, 'validation.plain_text'),
    })
    .refine((values) => (toAmount(values.amount) ?? 0) <= heldOf(values.paymentId), {
      path: ['amount'],
      message: 'billing:refund.amountTooMuch',
    });
}
export type RefundInput = z.input<ReturnType<typeof createRefundSchema>>;
export type RefundValues = z.output<ReturnType<typeof createRefundSchema>>;

export const creditNoteSchema: z.ZodType<CreditNote> = z.object({
  id: z.string(),
  invoiceId: z.string(),
  number: z.string(),
  amountMinor: z.number().int(),
  reason: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
});

export const creditNoteListSchema = z.object({ items: z.array(creditNoteSchema) });

/**
 * The form to issue a credit note (#112): an amount, more than nothing and at most `leftMinor`
 * (what can be credited without refunding money first), and a reason, which is required.
 */
export function createCreditNoteSchema(
  toAmount: (text: string) => number | null,
  leftMinor: number,
) {
  return z.object({
    amount: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toAmount(text) !== null, 'validation.invalid_format')
      .refine((text) => (toAmount(text) ?? 1) > 0, 'billing:credit.amountPositive')
      .refine((text) => (toAmount(text) ?? 0) <= leftMinor, 'billing:credit.amountTooMuch'),
    reason: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(REASON_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  });
}
export type CreditNoteInput = z.input<ReturnType<typeof createCreditNoteSchema>>;
export type CreditNoteValues = z.output<ReturnType<typeof createCreditNoteSchema>>;

export const NOTE_MAX = 300;

const registerTotalSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  paidMinor: z.number().int(),
  refundedMinor: z.number().int(),
});

export const registerSessionSchema: z.ZodType<RegisterSession> = z.object({
  id: z.string(),
  openedByName: z.string(),
  openedAt: z.string(),
  openingMinor: z.number().int(),
  closedAt: z.string().optional(),
  expectedMinor: z.number().int(),
  countedMinor: z.number().int().optional(),
  differenceMinor: z.number().int().optional(),
  note: z.string().optional(),
  totals: z.array(registerTotalSchema),
});

export const registerSessionPageSchema: z.ZodType<RegisterSessionPage> = z.object({
  items: z.array(registerSessionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** The form to open the drawer: the cash in it, which may be nothing. */
export function createOpenRegisterSchema(toAmount: (text: string) => number | null) {
  return z.object({
    opening: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toAmount(text) !== null, 'validation.invalid_format'),
  });
}
export type OpenRegisterInput = z.input<ReturnType<typeof createOpenRegisterSchema>>;
export type OpenRegisterValues = z.output<ReturnType<typeof createOpenRegisterSchema>>;

/** The form to settle the drawer: the cash counted (nothing is allowed) and an optional note. */
export function createCloseRegisterSchema(toAmount: (text: string) => number | null) {
  return z.object({
    counted: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toAmount(text) !== null, 'validation.invalid_format'),
    note: z
      .string()
      .trim()
      .max(NOTE_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  });
}
export type CloseRegisterInput = z.input<ReturnType<typeof createCloseRegisterSchema>>;
export type CloseRegisterValues = z.output<ReturnType<typeof createCloseRegisterSchema>>;

/** The hospital's tax rates (#119). */
export const taxRatesSchema: z.ZodType<TaxRates> = z.object({
  items: z.array(z.object({ taxClass: z.enum(TAX_CLASSES), rateBp: z.number().int() })),
});

/**
 * The form for the tax rates: one percentage a class, kept as text until the screen reads it on
 * its digits (`percentToBp`): 0 to 100 with up to two decimals.
 */
export function createTaxRatesSchema(check: (text: string) => number | null) {
  const rate = z
    .string()
    .trim()
    .min(1, 'validation.required')
    .refine((text) => check(text) !== null, 'billing:tax.rateInvalid');
  return z.object({ exempt: rate, reduced: rate, standard: rate, higher: rate });
}
export type TaxRatesInput = z.input<ReturnType<typeof createTaxRatesSchema>>;
export type TaxRatesValues = z.output<ReturnType<typeof createTaxRatesSchema>>;
