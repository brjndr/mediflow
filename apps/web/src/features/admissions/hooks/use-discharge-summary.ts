import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  addSummaryAddendum,
  fetchAdmission,
  fetchDischargeSummary,
  recordSummaryPrint,
  saveDischargeSummary,
  signDischargeSummary,
} from '../api';
import type { DischargeSummarySave } from '../types';
import { admissionKeys } from './use-admissions';

const summaryKey = (tenantId: string, admissionId: string) =>
  [...admissionKeys.all(tenantId), 'discharge-summary', admissionId] as const;

/** The stay the summary is about. */
export function useStay(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...admissionKeys.all(tenantId ?? ''), 'stay', admissionId],
    queryFn: ({ signal }) => fetchAdmission(admissionId, signal),
    enabled: tenantId !== undefined && admissionId !== '',
    staleTime: 0,
    retry: false,
  });
}

/**
 * The summary of a stay. `summary` is null while none was started (the server's 404
 * `summary_not_found`); any other failure is an error. Read fresh: it changes under two doctors.
 */
export function useDischargeSummary(admissionId: string) {
  const tenantId = useTenant()?.id;
  const found = useQuery({
    queryKey: summaryKey(tenantId ?? '', admissionId),
    queryFn: async ({ signal }) => {
      try {
        return await fetchDischargeSummary(admissionId, signal);
      } catch (error) {
        if (isApiError(error) && error.serverCode === 'summary_not_found') return null;
        throw error;
      }
    },
    enabled: tenantId !== undefined && admissionId !== '',
    staleTime: 0,
    retry: false,
  });
  return found;
}

/** One idempotency key per distinct request body: a repeat of the same body is a retry. */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return (body: unknown) => {
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };
}

function useRefresh(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return async () => {
    if (tenantId) {
      await queryClient.invalidateQueries({ queryKey: summaryKey(tenantId, admissionId) });
    }
  };
}

export function useSaveSummary(admissionId: string) {
  const keyFor = useAttempt();
  const refresh = useRefresh(admissionId);
  return useMutation({
    gcTime: 0,
    mutationFn: (body: DischargeSummarySave) =>
      saveDischargeSummary(admissionId, body, keyFor(body)),
    onSettled: refresh,
  });
}

export function useSignSummary(admissionId: string) {
  const keyFor = useAttempt();
  const refresh = useRefresh(admissionId);
  return useMutation({
    gcTime: 0,
    mutationFn: (version: number) =>
      signDischargeSummary(admissionId, version, keyFor({ version })),
    onSettled: refresh,
  });
}

export function useAddAddendum(admissionId: string) {
  const keyFor = useAttempt();
  const refresh = useRefresh(admissionId);
  return useMutation({
    gcTime: 0,
    mutationFn: ({ body, version }: { body: string; version: number }) =>
      addSummaryAddendum(admissionId, body, keyFor({ body, version })),
    onSettled: refresh,
  });
}

/**
 * A print: records it on the server first (a new key per press), and the page is drawn only
 * once that succeeded. `done` drops it when the print dialog closes.
 */
export function usePrintSummary(admissionId: string) {
  const [sheet, setSheet] = useState<number | null>(null);
  const count = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: () => recordSummaryPrint(admissionId, crypto.randomUUID()),
    onSuccess: () => {
      if (!alive.current) return;
      count.current += 1;
      setSheet(count.current);
    },
  });
  const { isPending, mutate } = mutation;
  const print = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  const done = useCallback(() => setSheet(null), []);
  return { print, busy: isPending, error: mutation.error, sheet, done };
}
