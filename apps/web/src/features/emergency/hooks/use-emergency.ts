import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchCases, identifyCase, registerCase, triageCase } from '../api';
import { PAGE_SIZE } from '../schemas';
import type { EmergencyCase, EmergencyCaseCreate, EmergencyCaseStatus } from '../types';

/** Every key is prefixed with the tenant, so one hospital's board never shows in another. */
export const emergencyKeys = createTenantKeys('emergency-cases');

/** The board is read again this often: the whole department looks at it. */
export const REFRESH_MS = 10_000;

export function useCases(status: EmergencyCaseStatus | undefined) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: emergencyKeys.list(tenantId ?? '', { status, limit: PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchCases({ status, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** The clock the waiting times are drawn from, moved on every `everyMs`. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
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

function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (tenantId) void queryClient.invalidateQueries({ queryKey: emergencyKeys.all(tenantId) });
  };
}

export function useRegisterCase() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: EmergencyCaseCreate) => registerCase(body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useTriageCase() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { row: EmergencyCase; category: number }) =>
      triageCase(change, attempt.keyFor([change.row.id, change.row.version, change.category])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useIdentifyCase() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { row: EmergencyCase; patientId: string }) =>
      identifyCase(change, attempt.keyFor([change.row.id, change.row.version, change.patientId])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}
