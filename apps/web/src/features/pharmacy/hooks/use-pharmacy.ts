import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  completeLine,
  createDispense,
  fetchOptions,
  fetchPrescription,
  fetchQueue,
  recordSlipPrint,
  type QueueFilters,
} from '../api';
import type { Dispense, DispenseCreate, PharmacyLine, PharmacyPrescription } from '../types';

/** Every key is prefixed with the tenant, so one hospital's queue never shows in another. */
export const pharmacyKeys = createTenantKeys('pharmacy');
/**
 * What may be given for a line, apart from the lists: reading the prescription and the queue
 * again after a dispense leaves it alone, and the panel reads it again after a refusal of stock.
 */
const optionKeys = createTenantKeys('pharmacyOptions');

export const QUEUE_PAGE_SIZE = 25;

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
 */
export function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return useCallback(() => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  }, [queryClient, tenantId, userId]);
}

/**
 * A key per request body: an identical resubmit (a double click, a retry after a lost answer)
 * reuses it and is done once, so stock leaves once; another body gets a new key.
 */
export function useIdempotencyKey() {
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

/** The queue in one state, a page at a time. */
export function useQueue(filters: QueueFilters) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: pharmacyKeys.list(tenantId ?? '', { ...filters, limit: QUEUE_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchQueue({ ...filters, cursor: pageParam, limit: QUEUE_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

/**
 * A prescription as the pharmacy dispenses it. Kept in memory only, and dropped soon after the
 * screen is left: it is a patient's record.
 */
export function usePrescription(prescriptionId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: pharmacyKeys.detail(tenantId ?? '', prescriptionId),
    queryFn: ({ signal }) => fetchPrescription(prescriptionId, signal),
    enabled: tenantId !== undefined,
    gcTime: 30_000,
  });
}

/** What may be given for a line at a place, read afresh each time the panel opens. */
export function useDispenseOptions(orderId: string, locationId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: optionKeys.list(tenantId ?? '', { orderId, locationId }),
    queryFn: ({ signal }) => fetchOptions(orderId, locationId, signal),
    enabled: tenantId !== undefined && locationId !== '',
    gcTime: 0,
    staleTime: 0,
  });
}

/** Whatever the answer, the prescription and the queue are read again. */
function useRefresh(prescriptionId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (!tenantId) return;
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: pharmacyKeys.lists(tenantId) }),
      queryClient.invalidateQueries({ queryKey: pharmacyKeys.detail(tenantId, prescriptionId) }),
    ]);
  };
}

/** Dispenses units of a line from batches at a place: one key per body, so a retry gives once. */
export function useDispense(prescriptionId: string) {
  const refresh = useRefresh(prescriptionId);
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the panel is gone.
    gcTime: 0,
    mutationFn: (body: DispenseCreate): Promise<Dispense> =>
      createDispense(body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** Completes a line in progress, at its version. */
export function useCompleteLine(prescriptionId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const refresh = useRefresh(prescriptionId);
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (line: PharmacyLine) =>
      completeLine(
        line.orderId,
        line.version,
        keys.keyFor({ id: line.orderId, version: line.version }),
      ),
    onSuccess: (prescription: PharmacyPrescription) => {
      keys.clear();
      const tenantId = stillHere();
      if (tenantId)
        queryClient.setQueryData(pharmacyKeys.detail(tenantId, prescriptionId), prescription);
    },
    onSettled: refresh,
  });
}

/**
 * Printing a dispense slip: the print is recorded on the server first, with a new key per press;
 * the page is shown (`job`) only once that succeeded, and only for the session it was asked in.
 * `done` drops it when the print dialog closes.
 */
export function usePrintSlip() {
  const stillHere = useStillHere();
  const [job, setJob] = useState<{ id: number; dispense: Dispense } | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (dispense: Dispense) => {
      await recordSlipPrint(dispense.id, crypto.randomUUID());
      return dispense;
    },
    onSuccess: (dispense) => {
      if (stillHere() && live.current) setJob((now) => ({ id: (now?.id ?? 0) + 1, dispense }));
    },
  });
  const done = useCallback(() => setJob(null), []);
  return { print: mutation.mutate, busy: mutation.isPending, error: mutation.error, job, done };
}
