import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createInvoiceDraft,
  fetchEncounterInvoices,
  fetchInvoice,
  fetchPendingCharges,
  issueInvoice,
  updateInvoiceDraft,
} from '../api';
import type { Invoice, InvoiceContent } from '../types';

/** Every key is prefixed with the tenant, so one hospital's bills never show in another. */
export const billingKeys = createTenantKeys('billing');

const chargesKey = (tenantId: string, encounterId: string) =>
  [...billingKeys.all(tenantId), 'charges', encounterId] as const;
const visitInvoicesKey = (tenantId: string, encounterId: string) =>
  [...billingKeys.all(tenantId), 'visit-invoices', encounterId] as const;

const CHARGES_PAGE_SIZE = 100;
const INVOICES_PAGE_SIZE = 50;

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
 */
function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  };
}

/**
 * A key per request body: an identical resubmit (a double click, a retry) reuses it and is done
 * once, while another body gets a new key.
 */
function useIdempotencyKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMemo(
    () => ({
      keyFor(body: unknown) {
        const serialized = JSON.stringify(body);
        if (attempt.current?.body !== serialized) {
          attempt.current = { body: serialized, key: crypto.randomUUID() };
        }
        return attempt.current.key;
      },
      clear() {
        attempt.current = undefined;
      },
    }),
    [],
  );
}

/** The visit's charges still to be billed (those held by another draft say so). */
export function usePendingCharges(encounterId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: chargesKey(tenantId ?? '', encounterId),
    queryFn: ({ pageParam, signal }) =>
      fetchPendingCharges({ encounterId, cursor: pageParam, limit: CHARGES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && encounterId !== '',
  });
}

/** The visit's invoices, newest first: where an unfinished draft is found. */
export function useVisitInvoices(encounterId: string, { enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: visitInvoicesKey(tenantId ?? '', encounterId),
    queryFn: ({ pageParam, signal }) =>
      fetchEncounterInvoices({ encounterId, cursor: pageParam, limit: INVOICES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined && encounterId !== '',
  });
}

export function useInvoice(invoiceId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: billingKeys.detail(tenantId ?? '', invoiceId),
    queryFn: ({ signal }) => fetchInvoice(invoiceId, signal),
    enabled: tenantId !== undefined && invoiceId !== '',
  });
}

/**
 * Whatever the answer, what the bill is made of has changed or may have: the visit's charges and
 * invoices and the invoice itself are read again.
 */
function useRefreshBilling() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: billingKeys.all(tenantId) });
  };
}

export function useCreateDraft(encounterId: string) {
  const refresh = useRefreshBilling();
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the form is gone.
    gcTime: 0,
    mutationFn: (body: InvoiceContent) => createInvoiceDraft(encounterId, body, keys.keyFor(body)),
    onSuccess: (invoice) => {
      keys.clear();
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(billingKeys.detail(tenantId, invoice.id), invoice);
    },
    onSettled: refresh,
  });
}

/** Saving the draft sends the version it was read at; a stale one is the server's 409. */
export function useUpdateDraft(invoiceId: string) {
  const refresh = useRefreshBilling();
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ content, version }: { content: InvoiceContent; version: number }) =>
      updateInvoiceDraft(invoiceId, { ...content, version }),
    onSuccess: (invoice) => {
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(billingKeys.detail(tenantId, invoice.id), invoice);
    },
    onSettled: refresh,
  });
}

export function useIssueInvoice() {
  const refresh = useRefreshBilling();
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ invoiceId, version }: { invoiceId: string; version: number }) =>
      issueInvoice(invoiceId, version, keys.keyFor({ invoiceId, version })),
    onSuccess: (invoice: Invoice) => {
      keys.clear();
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(billingKeys.detail(tenantId, invoice.id), invoice);
    },
    onSettled: refresh,
  });
}
