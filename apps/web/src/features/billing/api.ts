import { api, isApiError, requireData } from '@/shared/api';
import {
  chargePageSchema,
  chargeSchema,
  creditNoteListSchema,
  creditNoteSchema,
  discountSettingsSchema,
  invoicePageSchema,
  invoiceSchema,
  paymentListSchema,
  paymentSchema,
  registerSessionPageSchema,
  registerSessionSchema,
  taxRatesSchema,
} from './schemas';
import type {
  ChargePage,
  Charge,
  ChargeCreate,
  CreditNote,
  CreditNoteCreate,
  DiscountSettings,
  Invoice,
  InvoiceContent,
  InvoicePage,
  InvoiceUpdate,
  Payment,
  PaymentCreate,
  RefundCreate,
  RegisterClose,
  RegisterOpen,
  RegisterSession,
  RegisterSessionPage,
  TaxRate,
  TaxRates,
} from './types';

// Every address holds ids only: nothing about the patient is in a URL. Every POST carries an
// idempotency key, which the API requires.

/** The visit's charges still to be billed, oldest first. */
export async function fetchPendingCharges(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ChargePage> {
  const result = await api.GET('/encounters/{encounterId}/charges', {
    params: { path: { encounterId }, query: { status: 'pending', cursor, limit } },
    signal,
  });
  return chargePageSchema.parse(requireData(result));
}

/**
 * Charges a service of the price catalog to the visit. The server prices it from the price list
 * in effect; only the service and how many are sent. The key makes a repeat post one charge.
 */
export async function createCharge(
  encounterId: string,
  body: ChargeCreate,
  idempotencyKey: string,
): Promise<Charge> {
  const result = await api.POST('/encounters/{encounterId}/charges', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return chargeSchema.parse(requireData(result));
}

/** The visit's invoices, newest first, drafts included. */
export async function fetchEncounterInvoices(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<InvoicePage> {
  const result = await api.GET('/encounters/{encounterId}/invoices', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return invoicePageSchema.parse(requireData(result));
}

export async function fetchInvoice(invoiceId: string, signal?: AbortSignal): Promise<Invoice> {
  const result = await api.GET('/invoices/{invoiceId}', {
    params: { path: { invoiceId } },
    signal,
  });
  return invoiceSchema.parse(requireData(result));
}

export async function createInvoiceDraft(
  encounterId: string,
  body: InvoiceContent,
  idempotencyKey: string,
): Promise<Invoice> {
  const result = await api.POST('/encounters/{encounterId}/invoices', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return invoiceSchema.parse(requireData(result));
}

export async function updateInvoiceDraft(invoiceId: string, body: InvoiceUpdate): Promise<Invoice> {
  const result = await api.PATCH('/invoices/{invoiceId}', {
    params: { path: { invoiceId } },
    body,
  });
  return invoiceSchema.parse(requireData(result));
}

export async function issueInvoice(
  invoiceId: string,
  version: number,
  idempotencyKey: string,
): Promise<Invoice> {
  const result = await api.POST('/invoices/{invoiceId}/issue', {
    params: { path: { invoiceId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return invoiceSchema.parse(requireData(result));
}

export interface InvoiceFilters {
  q?: string;
  status?: Invoice['status'];
  cursor?: string;
  limit: number;
}

/**
 * The hospital's invoices, newest first. A POST so that the term, which can name a patient, stays
 * out of the address and the logs in front of the API.
 */
export async function searchInvoices(
  { q, status, cursor, limit }: InvoiceFilters,
  signal?: AbortSignal,
): Promise<InvoicePage> {
  const result = await api.POST('/invoices/search', {
    body: { q: q || undefined, status, cursor, limit },
    signal,
  });
  return invoicePageSchema.parse(requireData(result));
}

/** Records a print of the invoice in the audit log; nothing prints until it is answered. */
export async function recordInvoicePrint(
  invoiceId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<void> {
  await api.POST('/invoices/{invoiceId}/print', {
    params: { path: { invoiceId }, header: { 'idempotency-key': idempotencyKey } },
    signal,
  });
}

/** Every payment and refund of an invoice, oldest first (#111). */
export async function fetchPayments(invoiceId: string, signal?: AbortSignal): Promise<Payment[]> {
  const result = await api.GET('/invoices/{invoiceId}/payments', {
    params: { path: { invoiceId } },
    signal,
  });
  return paymentListSchema.parse(requireData(result)).items;
}

/** Every credit note of an invoice, oldest first (#112). */
export async function fetchCreditNotes(
  invoiceId: string,
  signal?: AbortSignal,
): Promise<CreditNote[]> {
  const result = await api.GET('/invoices/{invoiceId}/credit-notes', {
    params: { path: { invoiceId } },
    signal,
  });
  return creditNoteListSchema.parse(requireData(result)).items;
}

/** One credit note; a repeat with the same key issues nothing more (#112). */
export async function issueCreditNote(
  invoiceId: string,
  body: CreditNoteCreate,
  idempotencyKey: string,
): Promise<CreditNote> {
  const result = await api.POST('/invoices/{invoiceId}/credit-notes', {
    params: { path: { invoiceId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return creditNoteSchema.parse(requireData(result));
}

/** One payment; a repeat with the same key records nothing more (#111). */
export async function recordPayment(
  invoiceId: string,
  body: PaymentCreate,
  idempotencyKey: string,
): Promise<Payment> {
  const result = await api.POST('/invoices/{invoiceId}/payments', {
    params: { path: { invoiceId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return paymentSchema.parse(requireData(result));
}

/** One refund of part or all of a payment; a repeat with the same key refunds nothing more (#444). */
export async function refundPayment(
  paymentId: string,
  body: RefundCreate,
  idempotencyKey: string,
): Promise<Payment> {
  const result = await api.POST('/payments/{paymentId}/refunds', {
    params: { path: { paymentId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return paymentSchema.parse(requireData(result));
}

/** The caller's open register session, or null when they have none (404 `session_not_found`). */
export async function fetchCurrentRegister(signal?: AbortSignal): Promise<RegisterSession | null> {
  try {
    const result = await api.GET('/cash-registers/sessions/current', { signal });
    return registerSessionSchema.parse(requireData(result));
  } catch (error) {
    if (isApiError(error) && error.serverCode === 'session_not_found') return null;
    throw error;
  }
}

/** The hospital's register sessions, newest first (`cashRegister:read`). */
export async function fetchRegisterSessions(
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<RegisterSessionPage> {
  const result = await api.GET('/cash-registers/sessions', {
    params: { query: { cursor, limit } },
    signal,
  });
  return registerSessionPageSchema.parse(requireData(result));
}

export async function fetchRegisterSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<RegisterSession> {
  const result = await api.GET('/cash-registers/sessions/{sessionId}', {
    params: { path: { sessionId } },
    signal,
  });
  return registerSessionSchema.parse(requireData(result));
}

/** Opens the caller's drawer; a repeat with the same key opens nothing more. */
export async function openRegister(
  body: RegisterOpen,
  idempotencyKey: string,
): Promise<RegisterSession> {
  const result = await api.POST('/cash-registers/sessions', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return registerSessionSchema.parse(requireData(result));
}

/** Settles the caller's drawer with the cash counted; the session is final after it. */
export async function closeRegister(
  sessionId: string,
  body: RegisterClose,
  idempotencyKey: string,
): Promise<RegisterSession> {
  const result = await api.POST('/cash-registers/sessions/{sessionId}/close', {
    params: { path: { sessionId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return registerSessionSchema.parse(requireData(result));
}

/** The tax rate of every class at the hospital. */
export async function fetchTaxRates(signal?: AbortSignal): Promise<TaxRates> {
  const result = await api.GET('/billing/tax-rates', { signal });
  return taxRatesSchema.parse(requireData(result));
}

/** Sets the rates of the classes named; drafts take them when next saved, issued bills never change. */
export async function setTaxRates(items: TaxRate[], idempotencyKey: string): Promise<TaxRates> {
  const result = await api.PUT('/billing/tax-rates', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body: { items },
  });
  return taxRatesSchema.parse(requireData(result));
}

/** The most a bill may be discounted without approval, in basis points. */
export async function fetchDiscountSettings(signal?: AbortSignal): Promise<DiscountSettings> {
  const result = await api.GET('/billing/discount-settings', { signal });
  return discountSettingsSchema.parse(requireData(result));
}

export async function setDiscountSettings(
  limitBp: number,
  idempotencyKey: string,
): Promise<DiscountSettings> {
  const result = await api.PUT('/billing/discount-settings', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body: { limitBp },
  });
  return discountSettingsSchema.parse(requireData(result));
}

/** A second person approves the discount on a draft, at the version they saw. */
export async function approveInvoiceDiscount(
  invoiceId: string,
  version: number,
  idempotencyKey: string,
): Promise<Invoice> {
  const result = await api.POST('/invoices/{invoiceId}/discount-approval', {
    params: { path: { invoiceId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return invoiceSchema.parse(requireData(result));
}
