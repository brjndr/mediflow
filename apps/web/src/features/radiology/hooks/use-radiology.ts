import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  fetchWorklist,
  performStudy,
  scheduleStudy,
  unscheduleStudy,
  type WorklistFilters,
} from '../api';
import type { ImagingStudy, ImagingWorkItem } from '../types';

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
