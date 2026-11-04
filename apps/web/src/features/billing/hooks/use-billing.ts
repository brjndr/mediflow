import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys, isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  approveInvoiceDiscount,
  createCharge,
  closeRegister,
  createInvoiceDraft,
  fetchCurrentRegister,
  fetchRegisterSession,
  fetchRegisterSessions,
  openRegister,
  fetchEncounterInvoices,
  fetchCreditNotes,
  fetchInvoice,
  fetchPayments,
  fetchPendingCharges,
  issueCreditNote,
  issueInvoice,
  recordInvoicePrint,
  recordPayment,
  refundPayment,
  searchInvoices,
  setTaxRates,
  fetchTaxRates,
  fetchDiscountSettings,
  setDiscountSettings,
  updateInvoiceDraft,
} from '../api';
import type {
  Charge,
  ChargeCreate,
  CreditNoteCreate,
  DiscountSettings,
  Invoice,
  InvoiceContent,
  PaymentCreate,
  RefundCreate,
  RegisterClose,
  RegisterOpen,
  RegisterSession,
  TaxRate,
  TaxRates,
} from '../types';

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

/**
 * Charges a service to the visit. One key per body until it is posted, so a double press or a
 * retry after a lost answer posts one charge; another service or number is another key. Whatever
 * the answer, the visit's charges are read again.
 */
export function useAddCharge(encounterId: string) {
  const refresh = useRefreshBilling();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: ChargeCreate): Promise<Charge> =>
      createCharge(encounterId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
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

/** The invoice's payments and refunds, for `payment:read` (`enabled` is false without it). */
export function usePayments(invoiceId: string, { enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...billingKeys.all(tenantId ?? ''), 'payments', invoiceId],
    queryFn: ({ signal }) => fetchPayments(invoiceId, signal),
    enabled: enabled && tenantId !== undefined && invoiceId !== '',
  });
}

/**
 * Takes a payment. The key is made when the form first sends a body and kept until it is
 * recorded, so a double press, or a retry after a lost answer, records one payment; another
 * amount or mode is another body and another key. Whatever the answer, the invoice, its
 * payments and the lists are read again (a refusal such as `overpayment` means they changed).
 */
export function useRecordPayment(invoiceId: string) {
  const refresh = useRefreshBilling();
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the payment stays in the mutation cache once the form is gone.
    gcTime: 0,
    mutationFn: (body: PaymentCreate) => recordPayment(invoiceId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/**
 * Refunds part or all of a payment (#444). As a payment: one key per payment and body until it is
 * refunded, so a double press or a retry refunds once. Whatever the answer, the invoice, its
 * payments and the lists are read again. The reason is not kept in the mutation cache.
 */
export function useRefundPayment() {
  const refresh = useRefreshBilling();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ paymentId, ...body }: RefundCreate & { paymentId: string }) =>
      refundPayment(paymentId, body, keys.keyFor({ paymentId, ...body })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export const INVOICE_PAGE_SIZES = [25, 50, 100] as const;
export const SEARCH_DEBOUNCE_MS = 300;

/** Failures worth a second try: the request may not have reached a working server at all. */
const RETRYABLE = new Set(['network', 'timeout', 'server']);

export interface InvoiceListFilters {
  q: string;
  status: Invoice['status'] | null;
  limit: number;
}

/**
 * The invoice list, one server page at a time. The term and the status are the server's job: any
 * change is a new query from the first page, and the previous request is aborted.
 */
export function useInvoices({ q, status, limit }: InvoiceListFilters) {
  const tenantId = useTenant()?.id;
  const term = q.trim();
  return useInfiniteQuery({
    queryKey: billingKeys.list(tenantId ?? '', { q: term, status, limit }),
    queryFn: ({ pageParam, signal }) =>
      searchInvoices({ q: term, status: status ?? undefined, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
    // A POST is not retried by the fetch wrapper; it only reads, so a passing failure is.
    retry: (failures, error) => failures < 2 && isApiError(error) && RETRYABLE.has(error.code),
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
  });
}

/**
 * A print of an issued invoice: the invoice read afresh, then the print recorded on the server
 * with a new idempotency key per press; the page is shown (`job`) only once both succeeded, and
 * only for the session it was asked in. `done` drops it when the print dialog closes. Leaving the
 * page aborts the read.
 */
export function useInvoicePrinting(invoiceId: string) {
  const stillHere = useStillHere();
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const [job, setJob] = useState<{ id: number; value: Invoice } | null>(null);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      abort.current = new AbortController();
      const invoice = await fetchInvoice(invoiceId, abort.current.signal);
      await recordInvoicePrint(invoiceId, crypto.randomUUID(), abort.current.signal);
      return invoice;
    },
    onSuccess: (value) => {
      if (stillHere() && !abort.current?.signal.aborted)
        setJob((now) => ({ id: (now?.id ?? 0) + 1, value }));
    },
  });
  const { isPending, mutate } = mutation;
  const print = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  const done = useCallback(() => setJob(null), []);
  return { print, busy: isPending, error: mutation.error, job, done };
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The invoice's credit notes, for `invoice:read`. */
export function useCreditNotes(invoiceId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...billingKeys.all(tenantId ?? ''), 'credit-notes', invoiceId],
    queryFn: ({ signal }) => fetchCreditNotes(invoiceId, signal),
    enabled: tenantId !== undefined && invoiceId !== '',
  });
}

/**
 * Issues a credit note. As a payment: one key per body until it is issued, so a double press or
 * a retry makes one note. Whatever the answer, the invoice (it may now be void), its payments,
 * notes and the lists are read again.
 */
export function useIssueCreditNote(invoiceId: string) {
  const refresh = useRefreshBilling();
  const keys = useIdempotencyKey();
  return useMutation({
    // The reason is free text about a patient's bill: it does not stay in the mutation cache.
    gcTime: 0,
    mutationFn: (body: CreditNoteCreate) => issueCreditNote(invoiceId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export const REGISTER_PAGE_SIZES = [25, 50, 100] as const;

const registerKey = (tenantId: string, ...rest: unknown[]) =>
  [...billingKeys.all(tenantId), 'register', ...rest] as const;

/** The caller's own open drawer, or null when they have none (for `cashRegister:manage`). */
export function useCurrentRegister({ enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: registerKey(tenantId ?? '', 'current'),
    queryFn: ({ signal }) => fetchCurrentRegister(signal),
    enabled: enabled && tenantId !== undefined,
    // Cash payments change what the drawer holds, so it is read again when the screen returns.
    staleTime: 0,
  });
}

/** Every session of the hospital, newest first, one server page at a time. */
export function useRegisterSessions(limit: number, { enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: registerKey(tenantId ?? '', 'list', limit),
    queryFn: ({ pageParam, signal }) => fetchRegisterSessions({ cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined,
    placeholderData: (previous) => previous,
  });
}

export function useRegisterSession(sessionId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: registerKey(tenantId ?? '', 'detail', sessionId),
    queryFn: ({ signal }) => fetchRegisterSession(sessionId, signal),
    enabled: tenantId !== undefined && sessionId !== '',
  });
}

/**
 * Whatever the answer, billing's reads are made again: a refusal such as `register_open` or
 * `register_closed` means the drawer changed, and a closed one changes what a cash payment needs.
 */
function useRefreshRegister() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: billingKeys.all(tenantId) });
  };
}

/** Opens the drawer. One key per body until it is open, so a double press opens one. */
export function useOpenRegister() {
  const refresh = useRefreshRegister();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: RegisterOpen): Promise<RegisterSession> =>
      openRegister(body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** Settles the drawer. The note is free text and does not stay in the mutation cache. */
export function useCloseRegister(sessionId: string) {
  const refresh = useRefreshRegister();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: RegisterClose): Promise<RegisterSession> =>
      closeRegister(sessionId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** The hospital's tax rate for each class (any reader of invoices). */
export function useTaxRates({ enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...billingKeys.all(tenantId ?? ''), 'tax-rates'] as const,
    queryFn: ({ signal }) => fetchTaxRates(signal),
    enabled: enabled && tenantId !== undefined,
  });
}

/** Sets the rates. One key per body until saved; read again whatever the answer. */
export function useSetTaxRates() {
  const refresh = useRefreshRegister();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (items: TaxRate[]): Promise<TaxRates> => setTaxRates(items, keys.keyFor(items)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** The share of a bill that may be discounted without approval (any reader of invoices). */
export function useDiscountSettings({ enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...billingKeys.all(tenantId ?? ''), 'discount-settings'] as const,
    queryFn: ({ signal }) => fetchDiscountSettings(signal),
    enabled: enabled && tenantId !== undefined,
  });
}

/** Sets the limit. One key per value until saved; read again whatever the answer. */
export function useSetDiscountSettings() {
  const refresh = useRefreshRegister();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (limitBp: number): Promise<DiscountSettings> =>
      setDiscountSettings(limitBp, keys.keyFor({ limitBp })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** Approves the discount on a draft. One key per invoice and version until it is approved. */
export function useApproveDiscount() {
  const refresh = useRefreshBilling();
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ invoiceId, version }: { invoiceId: string; version: number }) =>
      approveInvoiceDiscount(invoiceId, version, keys.keyFor({ invoiceId, version })),
    onSuccess: (invoice: Invoice) => {
      keys.clear();
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(billingKeys.detail(tenantId, invoice.id), invoice);
    },
    onSettled: refresh,
  });
}
