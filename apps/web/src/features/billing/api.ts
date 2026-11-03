import { api, requireData } from '@/shared/api';
import { chargePageSchema, invoicePageSchema, invoiceSchema } from './schemas';
import type { ChargePage, Invoice, InvoiceContent, InvoicePage, InvoiceUpdate } from './types';

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
