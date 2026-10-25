import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import { useTenant } from '@/tenancy';
import {
  addAddendum,
  fetchReport,
  fetchWorklist,
  saveReport,
  signReport,
  performStudy,
  scheduleStudy,
  unscheduleStudy,
  type WorklistFilters,
} from '../api';
import type {
  AddendumReason,
  ImagingReport,
  ImagingReportDraft,
  ImagingStudy,
  ImagingWorkItem,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's worklist never shows in another. */
export const radiologyKeys = createTenantKeys('radiology');

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
    queryKey: radiologyKeys.list(tenantId ?? '', { ...filters, limit: WORKLIST_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchWorklist({ ...filters, cursor: pageParam, limit: WORKLIST_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

/** Whatever the answer, the worklist is read again: every stage, as an order moves between them. */
function useRefreshWorklist() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: radiologyKeys.all(tenantId) });
  };
}

/** Schedules or reschedules a study, from the study's version once it has one. */
export function useScheduleStudy() {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the panel is gone.
    gcTime: 0,
    mutationFn: ({ item, scheduledAt }: { item: ImagingWorkItem; scheduledAt: string }) => {
      const body = {
        scheduledAt,
        ...(item.study ? { version: item.study.version } : {}),
      };
      return scheduleStudy(item.orderId, body, keys.keyFor({ id: item.orderId, ...body }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** A change of a study at its version, with no form: unscheduling or performing it. */
function useStudyChange(
  send: (orderId: string, body: { version: number }, key: string) => Promise<ImagingStudy>,
) {
  const refresh = useRefreshWorklist();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (study: ImagingStudy) => {
      const body = { version: study.version };
      return send(study.orderId, body, keys.keyFor({ id: study.orderId, ...body }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export const useUnscheduleStudy = () => useStudyChange(unscheduleStudy);
export const usePerformStudy = () => useStudyChange(performStudy);

/**
 * The report of an order's study, or null while it has none. Kept in memory only, and dropped
 * soon after the panel closes: it is a patient's record.
 */
export function useReport(orderId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: radiologyKeys.detail(tenantId ?? '', orderId),
    queryFn: ({ signal }) => fetchReport(orderId, signal),
    enabled: tenantId !== undefined,
    gcTime: 30_000,
  });
}

/**
 * A change of a report: the answer is the report as it now is, put where `useReport` reads it,
 * and the worklist's lists are read again. The report itself is not read again: that would be a
 * second request, and a second audited read, for what the answer already gave.
 */
function useReportChange<Variables>(
  send: (variables: Variables, keyFor: (body: unknown) => string) => Promise<ImagingReport>,
) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const refresh = () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: radiologyKeys.lists(tenantId) });
  };
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (variables: Variables) => send(variables, (body) => keys.keyFor(body)),
    onSuccess: (report) => {
      keys.clear();
      const tenantId = stillHere();
      if (tenantId)
        queryClient.setQueryData(radiologyKeys.detail(tenantId, report.orderId), report);
    },
    onSettled: refresh,
  });
}

/** Saves the whole draft, from the version the panel holds. */
export const useSaveReport = () =>
  useReportChange(({ orderId, draft }: { orderId: string; draft: ImagingReportDraft }, keyFor) =>
    saveReport(orderId, draft, keyFor({ id: orderId, ...draft })),
  );

/** Signs the draft at its version. */
export const useSignReport = () =>
  useReportChange(({ orderId, version }: { orderId: string; version: number }, keyFor) =>
    signReport(orderId, { version }, keyFor({ id: orderId, version })),
  );

/** Adds a signed addendum to a signed report. */
export const useAddAddendum = () =>
  useReportChange(
    (
      {
        orderId,
        body,
        reason,
      }: { orderId: string; body: RichTextDocument; reason: AddendumReason },
      keyFor,
    ) => addAddendum(orderId, { body, reason }, keyFor({ id: orderId, body, reason })),
  );
