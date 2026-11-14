import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  fetchDownloadUrl,
  fetchLimits,
  fetchOutstandingInvoices,
  fetchReport,
  fetchRun,
  fetchRuns,
  requestRun,
  type ReportDays,
} from '../api';
import { WORKING } from '../schemas';
import type { AgeBand, ReportKind } from '../types';

/** Every key is prefixed with the tenant, so one hospital's reports never show in another. */
export const reportKeys = createTenantKeys('reports');
const limitsKey = (tenantId: string) => [...reportKeys.all(tenantId), 'limits'] as const;

export const RUNS_PAGE_SIZE = 25;

/** A stored report is asked about soon at first, then less often, up to this long between asks. */
const FIRST_POLL_MS = 1_000;
const LONGEST_POLL_MS = 15_000;
export const pollDelay = (polls: number): number =>
  Math.min(FIRST_POLL_MS * 2 ** polls, LONGEST_POLL_MS);

/** The hospital's stored reports, newest first, without their results. */
export function useRuns() {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: reportKeys.list(tenantId ?? '', { limit: RUNS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchRuns({ cursor: pageParam, limit: RUNS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some((run) => WORKING.includes(run.status)))
        ? LONGEST_POLL_MS
        : false,
    // A tab nobody looks at does not ask.
    refetchIntervalInBackground: false,
  });
}

/**
 * One run, followed while a job works on it: 1, 2, 4, 8 seconds, then every 15, and not at all
 * while the tab is hidden. It stops at `succeeded` or `failed`.
 */
export function useRun(runId: string | null) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: reportKeys.detail(tenantId ?? '', runId ?? ''),
    queryFn: ({ signal }) => fetchRun(runId ?? '', signal),
    enabled: tenantId !== undefined && runId !== null,
    // A result is a table of counts; nothing stays in the cache once the screen is left.
    gcTime: 0,
    // A pure function of the answers so far, so it may be asked as often as the library likes.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined || !WORKING.includes(status)) return false;
      return pollDelay(Math.max(query.state.dataUpdateCount - 1, 0));
    },
    refetchIntervalInBackground: false,
  });
}

/** The invoices behind one age band of the outstanding report, a page at a time. */
export function useOutstandingInvoices(band: AgeBand) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: reportKeys.list(tenantId ?? '', { outstanding: band }),
    queryFn: ({ pageParam, signal }) =>
      fetchOutstandingInvoices(band, { cursor: pageParam, limit: RUNS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    // Money owed is read fresh each time a band is opened and kept nowhere afterwards.
    gcTime: 0,
  });
}

/** What the hospital may ask of the service and has used. */
export function useLimits() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: limitsKey(tenantId ?? ''),
    queryFn: ({ signal }) => fetchLimits(signal),
    enabled: tenantId !== undefined,
    staleTime: 30_000,
  });
}

/** A report worked out now. Nothing is kept once the screen is left. */
export function useSpotReport() {
  return useMutation({
    gcTime: 0,
    mutationFn: ({ kind, ...days }: { kind: ReportKind } & ReportDays) => fetchReport(kind, days),
  });
}

/**
 * A key per request: an identical resubmit (a double click, a retry) reuses it and is done once,
 * while another report or other days get a new key.
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

/** Asks for a stored report, then reads the list and the quota again. */
export function useRequestRun() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ kind, ...days }: { kind: ReportKind } & ReportDays) =>
      requestRun(kind, days, keys.keyFor({ kind, ...days })),
    onSuccess: () => keys.clear(),
    onSettled: () => {
      if (tenantId) void queryClient.invalidateQueries({ queryKey: reportKeys.all(tenantId) });
    },
  });
}

/** The signed link of a run's file, asked for when the person downloads and never cached. */
export function useDownloadLink() {
  return useMutation({ gcTime: 0, mutationFn: (runId: string) => fetchDownloadUrl(runId) });
}
