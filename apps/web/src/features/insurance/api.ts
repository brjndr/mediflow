import { api, requireData } from '@/shared/api';
import {
  payerDetailSchema,
  payerPageSchema,
  payerPlanSchema,
  payerSchema,
  rateAgreementSchema,
} from './schemas';
import type {
  Payer,
  PayerCreate,
  PayerDetail,
  PayerKind,
  PayerPage,
  PayerPlan,
  PayerPlanUpdate,
  PayerPlanWrite,
  PayerUpdate,
  RateAgreement,
  RateAgreementCreate,
} from './types';

export interface PayerFilters {
  /** A code or a name of an organisation. Not patient data, so it may be a query. */
  q: string;
  kind: PayerKind | '';
  archived: boolean;
}

const idempotent = (key: string) => ({ header: { 'idempotency-key': key } });

export async function fetchPayers(
  { cursor, limit, q, kind, archived }: PayerFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<PayerPage> {
  const result = await api.GET('/payers', {
    params: { query: { cursor, limit, q: q || undefined, kind: kind || undefined, archived } },
    signal,
  });
  return payerPageSchema.parse(requireData(result));
}

export async function fetchPayer(payerId: string, signal?: AbortSignal): Promise<PayerDetail> {
  const result = await api.GET('/payers/{payerId}', { params: { path: { payerId } }, signal });
  return payerDetailSchema.parse(requireData(result));
}

export async function createPayer(body: PayerCreate, key: string): Promise<Payer> {
  const result = await api.POST('/payers', { body, params: idempotent(key) });
  return payerSchema.parse(requireData(result));
}

export async function updatePayer(payerId: string, body: PayerUpdate): Promise<Payer> {
  const result = await api.PATCH('/payers/{payerId}', { params: { path: { payerId } }, body });
  return payerSchema.parse(requireData(result));
}

export async function createPlan(
  payerId: string,
  body: PayerPlanWrite,
  key: string,
): Promise<PayerPlan> {
  const result = await api.POST('/payers/{payerId}/plans', {
    params: { path: { payerId }, ...idempotent(key) },
    body,
  });
  return payerPlanSchema.parse(requireData(result));
}

export async function updatePlan(planId: string, body: PayerPlanUpdate): Promise<PayerPlan> {
  const result = await api.PATCH('/payer-plans/{planId}', { params: { path: { planId } }, body });
  return payerPlanSchema.parse(requireData(result));
}

export async function createAgreement(
  payerId: string,
  body: RateAgreementCreate,
  key: string,
): Promise<RateAgreement> {
  const result = await api.POST('/payers/{payerId}/rate-agreements', {
    params: { path: { payerId }, ...idempotent(key) },
    body,
  });
  return rateAgreementSchema.parse(requireData(result));
}

/** Sets the last day of an agreement, or opens its end again with `null`. */
export async function endAgreement(
  agreementId: string,
  body: { effectiveTo: string | null; version: number },
): Promise<RateAgreement> {
  const result = await api.PATCH('/rate-agreements/{agreementId}', {
    params: { path: { agreementId } },
    body,
  });
  return rateAgreementSchema.parse(requireData(result));
}
