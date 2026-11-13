import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys, isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  CREDIT_PAGE_SIZE,
  createCreditBill,
  fetchCreditAccount,
  fetchCreditAccounts,
  fetchCreditBills,
  fetchReceipts,
  fetchStatement,
  recordReceipt,
  saveCreditAccount,
  STATEMENT_PAGE_SIZE,
} from '../credit';
import type { CreditAccountWrite, CreditBillStatus, ReceiptCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's receivables never show in another. */
export const creditKeys = createTenantKeys('credit');

const STALE_TIME_MS = 15_000;

export function useCreditAccounts(enabled = true) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: creditKeys.list(tenantId ?? '', { kind: 'accounts', limit: CREDIT_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchCreditAccounts({ cursor: pageParam, limit: CREDIT_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** One account. A corporate with none answers 404: `isError` with that status means "no account". */
export function useCreditAccount(payerId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: creditKeys.detail(tenantId ?? '', payerId),
    queryFn: ({ signal }) => fetchCreditAccount(payerId, signal),
    enabled: tenantId !== undefined && payerId !== '',
    retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: true,
  });
}

export function useCreditBills(payerId: string, status: CreditBillStatus | '') {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: creditKeys.list(tenantId ?? '', {
      kind: 'bills',
      payerId,
      status,
      limit: CREDIT_PAGE_SIZE,
    }),
    queryFn: ({ pageParam, signal }) =>
      fetchCreditBills({ payerId, status, cursor: pageParam, limit: CREDIT_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && payerId !== '',
    staleTime: STALE_TIME_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function useReceipts(payerId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: creditKeys.list(tenantId ?? '', { kind: 'receipts', payerId }),
    queryFn: ({ pageParam, signal }) =>
      fetchReceipts({ payerId, cursor: pageParam, limit: CREDIT_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && payerId !== '',
    staleTime: STALE_TIME_MS,
  });
}

/** The statement of a period. The first page carries the totals; later pages add lines. */
export function useStatement(payerId: string, from: string, to: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: creditKeys.list(tenantId ?? '', { kind: 'statement', payerId, from, to }),
    queryFn: ({ pageParam, signal }) =>
      fetchStatement({ payerId, from, to, cursor: pageParam, limit: STATEMENT_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined && payerId !== '' && from <= to,
    staleTime: STALE_TIME_MS,
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({ queryKey: creditKeys.all(tenantId) });
  };
}

export function useSaveCreditAccount(payerId: string) {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: CreditAccountWrite) => saveCreditAccount(payerId, body),
    onSettled: refresh,
  });
}

/** One key for one identical body: a second tap after a slow answer is the same request. */
export function useRecordReceipt(payerId: string) {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: ReceiptCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return recordReceipt(payerId, body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: refresh,
  });
}

export function useCreateCreditBill(encounterId: string) {
  const attempt = useRef<{ payerId: string; key: string }>(undefined);
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (payerId: string) => {
      if (attempt.current?.payerId !== payerId) {
        attempt.current = { payerId, key: crypto.randomUUID() };
      }
      return createCreditBill(encounterId, payerId, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: refresh,
  });
}
