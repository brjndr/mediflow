import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  collectSample,
  fetchWorklist,
  receiveSample,
  recordLabelPrint,
  rejectSample,
  type WorklistFilters,
} from '../api';
import type { LabSample, LabSampleReject, LabWorkItem } from '../types';

/** Every key is prefixed with the tenant, so one hospital's worklist never shows in another. */
export const labKeys = createTenantKeys('lab');

export const WORKLIST_PAGE_SIZE = 25;

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
 */
function useStillHere() {
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

/** The worklist at one stage, a page at a time. */
export function useWorklist(filters: WorklistFilters) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: labKeys.list(tenantId ?? '', { ...filters, limit: WORKLIST_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchWorklist({ ...filters, cursor: pageParam, limit: WORKLIST_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

/** Whatever the answer, the worklist is read again: every stage, as a sample moves between them. */
function useRefreshWorklist() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: labKeys.all(tenantId) });
  };
}

/** Collects the sample of an order. One key per order, so a double press collects one sample. */
export function useCollectSample() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the panel is gone.
    gcTime: 0,
    mutationFn: (item: LabWorkItem) =>
      collectSample(item.orderId, keys.keyFor({ orderId: item.orderId })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useReceiveSample() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (sample: LabSample) => {
      const body = { version: sample.version };
      return receiveSample(sample.id, body, keys.keyFor({ id: sample.id, ...body }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useRejectSample() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      sample,
      body,
    }: {
      sample: LabSample;
      body: Omit<LabSampleReject, 'version'>;
    }) => {
      const sent = { ...body, version: sample.version };
      return rejectSample(sample.id, sent, keys.keyFor({ id: sample.id, ...sent }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** What a label prints: the order it is for and its sample. */
export interface LabelJob {
  item: LabWorkItem;
  sample: LabSample;
}

/**
 * A label print: recorded on the server first, with a new idempotency key per press, then shown
 * (`job`) only for the session it was asked in. `done` drops it when the print dialog closes.
 */
export function useLabelPrinting() {
  const stillHere = useStillHere();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [job, setJob] = useState<{ id: number; value: LabelJob } | null>(null);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (value: LabelJob) => {
      await recordLabelPrint(value.sample.id, crypto.randomUUID());
      return value;
    },
    onSuccess: (value) => {
      if (stillHere() && live.current) setJob((now) => ({ id: (now?.id ?? 0) + 1, value }));
    },
  });
  const { isPending, mutate, reset } = mutation;
  const print = useCallback(
    (value: LabelJob) => {
      if (!isPending) mutate(value);
    },
    [isPending, mutate],
  );
  const done = useCallback(() => setJob(null), []);
  return { print, busy: isPending, error: mutation.error, reset, job, done };
}
