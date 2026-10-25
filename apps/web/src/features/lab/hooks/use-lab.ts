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
  acknowledgeResult,
  amendResult,
  collectSample,
  enterResults,
  fetchOrderResults,
  fetchWorklist,
  receiveSample,
  recordLabelPrint,
  recordReportPrint,
  rejectSample,
  returnPartnerReport,
  searchResults,
  sendOutSample,
  verifyResults,
  type WorklistFilters,
} from '../api';
import type {
  LabOrderResults,
  LabResult,
  LabResultAmend,
  LabResultEntry,
  LabSample,
  LabSampleReject,
  LabSampleSendOut,
  LabWorkItem,
} from '../types';

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

export function useSendOutSample() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      sample,
      body,
    }: {
      sample: LabSample;
      body: Omit<LabSampleSendOut, 'version'>;
    }) => {
      const sent = { ...body, version: sample.version };
      return sendOutSample(sample.id, sent, keys.keyFor({ id: sample.id, ...sent }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useReturnPartnerReport() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (sample: LabSample) => {
      const body = { version: sample.version };
      return returnPartnerReport(sample.id, body, keys.keyFor({ id: sample.id, ...body }));
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

/** The results of one lab order (#91), read again whenever the laboratory changes them. */
export function useOrderResults(orderId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: labKeys.detail(tenantId ?? '', orderId),
    queryFn: ({ signal }) => fetchOrderResults(orderId, signal),
    enabled: tenantId !== undefined,
  });
}

/**
 * After entering or verifying: the answer is the order's results as they are now, written to
 * its page for the session it was asked in; the worklist and the page are read again either way.
 */
function useResultsAnswered(orderId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const refresh = useRefreshWorklist();
  return {
    answered: (results: LabOrderResults) => {
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(labKeys.detail(tenantId, orderId), results);
    },
    refresh,
  };
}

/** Enters results of a received sample: the rows filled in, one key per body. */
export function useEnterResults(orderId: string) {
  const { answered, refresh } = useResultsAnswered(orderId);
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ sampleId, results }: { sampleId: string; results: LabResultEntry[] }) =>
      enterResults(sampleId, results, keys.keyFor({ sampleId, results })),
    onSuccess: (results) => {
      keys.clear();
      answered(results);
    },
    onSettled: refresh,
  });
}

/** Verifies the results the verifier read, by id. */
export function useVerifyResults(orderId: string) {
  const { answered, refresh } = useResultsAnswered(orderId);
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ sampleId, resultIds }: { sampleId: string; resultIds: string[] }) =>
      verifyResults(sampleId, resultIds, keys.keyFor({ sampleId, resultIds })),
    onSuccess: (results) => {
      keys.clear();
      answered(results);
    },
    onSettled: refresh,
  });
}

export const RELEASED_PAGE_SIZE = 25;
/** The most points of a trend: the newest hundred results of the test. */
export const TREND_SIZE = 100;

/**
 * A patient's released results (#92), the newest collected first, a page at a time: all of them
 * (the patient's tab) or one encounter's (the consultation). Read only while `enabled`.
 */
export function usePatientResults(
  filters: { patientId: string; encounterId?: string },
  enabled = true,
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: labKeys.list(tenantId ?? '', {
      released: true,
      ...filters,
      limit: RELEASED_PAGE_SIZE,
    }),
    queryFn: ({ pageParam, signal }) =>
      searchResults({ ...filters, cursor: pageParam, limit: RELEASED_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined && filters.patientId !== '',
  });
}

/** The newest results of one test of a patient (#92), for its trend: one page of a hundred. */
export function useResultTrend(patientId: string, labTestId: string | null) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: labKeys.list(tenantId ?? '', { trend: true, patientId, labTestId }),
    queryFn: ({ signal }) =>
      searchResults({ patientId, labTestId: labTestId ?? '', limit: TREND_SIZE }, signal),
    enabled: tenantId !== undefined && labTestId !== null,
  });
}

/**
 * Acknowledges a verified critical result, one key per result; whatever the answer, every
 * view of results is read again, as another doctor may have acknowledged it meanwhile.
 */
export function useAcknowledgeResult() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (result: LabResult) => acknowledgeResult(result.id, keys.keyFor(result.id)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/**
 * A report print (#92): the order's results read afresh, then the print recorded on the server
 * with a new idempotency key per press; the page is shown (`job`) only once both succeeded, and
 * only for the session it was asked in. `done` drops it when the print dialog closes. Leaving the
 * page aborts the read.
 */
export function useReportPrinting(orderId: string) {
  const stillHere = useStillHere();
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const [job, setJob] = useState<{ id: number; value: LabOrderResults } | null>(null);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      abort.current = new AbortController();
      const results = await fetchOrderResults(orderId, abort.current.signal);
      await recordReportPrint(orderId, crypto.randomUUID(), abort.current.signal);
      return results;
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

/** Corrects a result with a reason: a new result, to verify again. */
export function useAmendResult() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ result, body }: { result: LabResult; body: LabResultAmend }) =>
      amendResult(result.id, body, keys.keyFor({ id: result.id, ...body })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}
