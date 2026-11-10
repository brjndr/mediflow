import { z } from 'zod';
import { toMinor } from '@/features/services';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type { Payer, PayerDetail, PayerPage, PayerPlan, RateAgreement } from './types';

export const PAYER_KINDS = ['insurer', 'tpa', 'corporate'] as const;
export const COVERAGE_MODES = ['all_except', 'only_listed'] as const;

export const CODE_MAX = 20;
export const NAME_MAX = 100;
export const PAGE_SIZE = 25;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const payerSchema: z.ZodType<Payer> = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(PAYER_KINDS),
  code: z.string(),
  name: z.string(),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  planCount: z.number().int().min(0),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

export const payerPageSchema: z.ZodType<PayerPage> = z.object({
  items: z.array(payerSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const planSchema: z.ZodType<PayerPlan> = z.object({
  id: z.string(),
  payerId: z.string(),
  code: z.string(),
  name: z.string(),
  coverageMode: z.enum(COVERAGE_MODES),
  copayPercent: z.number().int().min(0).max(100),
  sumInsuredMinor: z.number().int().min(0).optional(),
  roomRentLimitMinor: z.number().int().min(0).optional(),
  preAuthRequired: z.boolean(),
  minAge: z.number().int().optional(),
  maxAge: z.number().int().optional(),
  waitingPeriodDays: z.number().int().optional(),
  services: z.array(
    z.object({
      serviceId: z.string(),
      serviceName: z.string(),
      limitMinor: z.number().int().min(0).optional(),
    }),
  ),
  archived: z.boolean(),
  version: z.number().int().min(1),
});
export const payerPlanSchema = planSchema;

const agreementSchema: z.ZodType<RateAgreement> = z.object({
  id: z.string(),
  payerId: z.string(),
  name: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().optional(),
  discountBp: z.number().int().min(0).max(10000),
  rates: z.array(
    z.object({
      serviceId: z.string(),
      serviceName: z.string(),
      rateMinor: z.number().int().min(0),
    }),
  ),
  version: z.number().int().min(1),
});
export const rateAgreementSchema = agreementSchema;

export const payerDetailSchema: z.ZodType<PayerDetail> = z.object({
  payer: payerSchema,
  plans: z.array(planSchema),
  agreements: z.array(agreementSchema),
});

const plain = (max: number) =>
  z.string().trim().max(max).regex(PLAIN_TEXT, 'validation.plain_text');
const optionalText = (max: number, pattern?: RegExp) =>
  plain(max).refine((value) => value === '' || !pattern || pattern.test(value), {
    message: 'validation.invalid_format',
  });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\s-]+$/;

const codeField = z
  .string()
  .trim()
  .min(1, 'validation.required')
  .max(CODE_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'validation.invalid_format');

/** The fields of a payer that change. The kind and the code are chosen when it is added. */
export const payerFormSchema = z.object({
  name: plain(NAME_MAX).min(1, 'validation.required'),
  contactName: plain(100),
  phone: optionalText(30, PHONE),
  email: optionalText(100, EMAIL),
  address: z.string().trim().max(300).regex(PLAIN_LINES, 'validation.plain_text'),
});
export type PayerFormValues = z.infer<typeof payerFormSchema>;
export type PayerField = keyof PayerFormValues;

export const payerCreateFormSchema = payerFormSchema.extend({
  kind: z.enum(PAYER_KINDS),
  code: codeField,
});
export type PayerCreateFormValues = z.infer<typeof payerCreateFormSchema>;

export const toPayerFormValues = (payer?: Payer): PayerFormValues => ({
  name: payer?.name ?? '',
  contactName: payer?.contactName ?? '',
  phone: payer?.phone ?? '',
  email: payer?.email ?? '',
  address: payer?.address ?? '',
});

/** A new payer as the API takes it: a field left empty is left out. */
export function toPayerCreate(values: PayerCreateFormValues) {
  const { kind, code, name, contactName, phone, email, address } = values;
  return {
    kind,
    code,
    name,
    ...(contactName ? { contactName } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(address ? { address } : {}),
  };
}

const digits = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d*$/, 'validation.invalid_format')
    .refine((value) => value === '' || Number(value) <= max, 'validation.too_big');
/** A typed amount, in the currency's own digits; read to minor units when saved. */
const amount = (currencyDigits: number) =>
  z
    .string()
    .trim()
    .refine((value) => value === '' || toMinor(value, currencyDigits) !== null, {
      message: 'validation.invalid_format',
    });

const serviceRow = (currencyDigits: number) =>
  z.object({ serviceId: z.string(), name: z.string(), amount: amount(currencyDigits) });
export type ServiceRow = { serviceId: string; name: string; amount: string };

/** The plan form. The minor-unit digits of the hospital's currency read the amounts. */
export const planFormSchema = (currencyDigits: number, adding: boolean) =>
  z
    .object({
      code: adding ? codeField : z.string(),
      name: plain(NAME_MAX).min(1, 'validation.required'),
      coverageMode: z.enum(COVERAGE_MODES),
      copayPercent: digits(100).min(1, 'validation.required'),
      sumInsured: amount(currencyDigits),
      roomRentLimit: amount(currencyDigits),
      preAuthRequired: z.boolean(),
      minAge: digits(120),
      maxAge: digits(120),
      waitingPeriodDays: digits(3650),
      services: z.array(serviceRow(currencyDigits)).max(500),
    })
    .superRefine((values, context) => {
      if (
        values.minAge !== '' &&
        values.maxAge !== '' &&
        Number(values.minAge) > Number(values.maxAge)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['maxAge'],
          message: 'insurance:plan.errors.ageOrder',
        });
      }
      if (values.coverageMode === 'only_listed' && values.services.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['services'],
          message: 'insurance:plan.errors.servicesNeeded',
        });
      }
    });
export type PlanFormValues = z.infer<ReturnType<typeof planFormSchema>>;

const minorText = (minor: number | undefined, currencyDigits: number) =>
  minor === undefined ? '' : (minor / 10 ** currencyDigits).toFixed(currencyDigits);

export const toPlanFormValues = (
  plan: PayerPlan | undefined,
  currencyDigits: number,
): PlanFormValues => ({
  code: plan?.code ?? '',
  name: plan?.name ?? '',
  coverageMode: plan?.coverageMode ?? 'all_except',
  copayPercent: String(plan?.copayPercent ?? 0),
  sumInsured: minorText(plan?.sumInsuredMinor, currencyDigits),
  roomRentLimit: minorText(plan?.roomRentLimitMinor, currencyDigits),
  preAuthRequired: plan?.preAuthRequired ?? false,
  minAge: plan?.minAge === undefined ? '' : String(plan.minAge),
  maxAge: plan?.maxAge === undefined ? '' : String(plan.maxAge),
  waitingPeriodDays: plan?.waitingPeriodDays === undefined ? '' : String(plan.waitingPeriodDays),
  services: (plan?.services ?? []).map((one) => ({
    serviceId: one.serviceId,
    name: one.serviceName,
    amount: minorText(one.limitMinor, currencyDigits),
  })),
});

/** The terms of a plan as the API takes them. A limit left empty means no limit. */
export function toPlanTerms(values: PlanFormValues, currencyDigits: number) {
  const minor = (text: string) => (text === '' ? undefined : (toMinor(text, currencyDigits) ?? 0));
  const optional = (name: string, value: number | undefined) =>
    value === undefined ? {} : { [name]: value };
  return {
    name: values.name,
    coverageMode: values.coverageMode,
    copayPercent: Number(values.copayPercent),
    preAuthRequired: values.preAuthRequired,
    ...optional('sumInsuredMinor', minor(values.sumInsured)),
    ...optional('roomRentLimitMinor', minor(values.roomRentLimit)),
    ...optional('minAge', values.minAge === '' ? undefined : Number(values.minAge)),
    ...optional('maxAge', values.maxAge === '' ? undefined : Number(values.maxAge)),
    ...optional(
      'waitingPeriodDays',
      values.waitingPeriodDays === '' ? undefined : Number(values.waitingPeriodDays),
    ),
    services: values.services.map((row) => ({
      serviceId: row.serviceId,
      ...optional('limitMinor', minor(row.amount)),
    })),
  };
}

/** The agreement form. A discount is a percent with up to two decimals. */
export const agreementFormSchema = (currencyDigits: number) =>
  z
    .object({
      name: plain(NAME_MAX).min(1, 'validation.required'),
      effectiveFrom: z.string().min(1, 'validation.required'),
      effectiveTo: z.string(),
      discountPercent: z
        .string()
        .trim()
        .min(1, 'validation.required')
        .regex(/^\d{1,3}(\.\d{1,2})?$/, 'validation.invalid_format')
        .refine((value) => Number(value) <= 100, 'validation.too_big'),
      rates: z
        .array(
          z.object({
            serviceId: z.string(),
            name: z.string(),
            amount: amount(currencyDigits).refine((value) => value !== '', 'validation.required'),
          }),
        )
        .max(500),
    })
    .superRefine((values, context) => {
      if (values.effectiveTo !== '' && values.effectiveTo < values.effectiveFrom) {
        context.addIssue({
          code: 'custom',
          path: ['effectiveTo'],
          message: 'insurance:agreement.errors.endBeforeStart',
        });
      }
    });
export type AgreementFormValues = z.infer<ReturnType<typeof agreementFormSchema>>;

/** 12.5 as basis points: on its digits, never through a float. */
export function toBasisPoints(percent: string): number {
  const [whole = '0', fraction = ''] = percent.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function toAgreementCreate(values: AgreementFormValues, currencyDigits: number) {
  return {
    name: values.name,
    effectiveFrom: values.effectiveFrom,
    ...(values.effectiveTo ? { effectiveTo: values.effectiveTo } : {}),
    discountBp: toBasisPoints(values.discountPercent),
    rates: values.rates.map((row) => ({
      serviceId: row.serviceId,
      rateMinor: toMinor(row.amount, currencyDigits) ?? 0,
    })),
  };
}
