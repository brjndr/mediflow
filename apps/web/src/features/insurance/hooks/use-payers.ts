import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createAgreement,
  createPayer,
  createPlan,
  endAgreement,
  fetchPayer,
  fetchPayers,
  updatePayer,
  updatePlan,
  type PayerFilters,
} from '../api';
import { PAGE_SIZE } from '../schemas';
import type { PayerCreate, PayerPlanUpdate, PayerPlanWrite, PayerUpdate } from '../types';
import type { RateAgreementCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's payers never show in another. */
export const payerKeys = createTenantKeys('payers');

const STALE_TIME_MS = 30_000;

export function usePayers(filters: PayerFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: payerKeys.list(tenantId ?? '', { ...filters, q, limit: PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchPayers({ ...filters, q, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    // The last page stays while a search is typed, but only at the same hospital.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function usePayer(payerId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: payerKeys.detail(tenantId ?? '', payerId),
    queryFn: ({ signal }) => fetchPayer(payerId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** One key for one identical body: a second tap after a slow answer is the same request. */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    keyFor: (body: unknown) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    done: () => {
      attempt.current = undefined;
    },
  };
}

/** After any change the lists and the payer's own page are read again, for this hospital only. */
function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({ queryKey: payerKeys.all(tenantId) });
  };
}

export function useCreatePayer() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PayerCreate) => createPayer(body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useUpdatePayer(payerId: string) {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PayerUpdate) => updatePayer(payerId, body),
    onSettled: refresh,
  });
}

export function useCreatePlan(payerId: string) {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PayerPlanWrite) => createPlan(payerId, body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useUpdatePlan() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ planId, body }: { planId: string; body: PayerPlanUpdate }) =>
      updatePlan(planId, body),
    onSettled: refresh,
  });
}

export function useCreateAgreement(payerId: string) {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: RateAgreementCreate) => createAgreement(payerId, body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useEndAgreement() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { agreementId: string; effectiveTo: string | null; version: number }) =>
      endAgreement(change.agreementId, {
        effectiveTo: change.effectiveTo,
        version: change.version,
      }),
    onSettled: refresh,
  });
}
