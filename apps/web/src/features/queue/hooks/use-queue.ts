import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createTenantKeys, followEventStream, type EventStreamStatus } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchQueueTokens, openQueueEvents, type QueueFilters } from '../api';
import { queueEventSchema } from '../schemas';

/** Every key is prefixed with the tenant, so one hospital's queue never shows in another. */
export const queueKeys = createTenantKeys('queue');

export const QUEUE_PAGE_SIZE = 50;

/** While the event stream is down the board reads the queue on its own, this often. */
export const FALLBACK_REFRESH_MS = 15_000;

/** Events that come close together are one refresh: a busy desk issues several a second. */
const EVENT_DEBOUNCE_MS = 300;
/** ...but a steady flow of events still refreshes the board at least this often. */
const EVENT_MAX_WAIT_MS = 1_000;

/** One group of today's queue (waiting, called, skipped), one server page at a time. */
export function useQueueTokens(
  filters: QueueFilters,
  { enabled, live }: { enabled: boolean; live: boolean },
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: queueKeys.list(tenantId ?? '', { ...filters, limit: QUEUE_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchQueueTokens({ ...filters, cursor: pageParam, limit: QUEUE_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined,
    // Events say when it changed; without them it is read again on a timer.
    staleTime: live ? Infinity : 0,
    refetchInterval: live ? false : FALLBACK_REFRESH_MS,
    // The previous filter's rows while the next come, never another hospital's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/**
 * Follows the hospital's queue events while the screen is open, and refreshes the queue when one
 * says it changed. Closed on leaving the screen, on a switch of hospital (a new stream for the
 * new one) and on sign-out, which unmounts the screen. Returns whether the stream is open.
 *
 * Each time it opens, the first time included, the queue is read once, for what changed while it
 * was not open: the lists were read before it opened. A board shown for one department
 * (`departmentId`) refreshes only for that department's events; changing it does not reopen the
 * stream.
 */
export function useQueueEvents(enabled: boolean, departmentId: string): EventStreamStatus | 'off' {
  const tenantId = useTenant()?.id;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventStreamStatus | 'off'>('off');
  const shown = useRef(departmentId);
  useEffect(() => {
    shown.current = departmentId;
  }, [departmentId]);

  useEffect(() => {
    if (!enabled || tenantId === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** When the first event not yet acted on came. */
    let firstAt: number | undefined;
    const refresh = () => {
      clearTimeout(timer);
      firstAt ??= Date.now();
      const wait = Math.min(EVENT_DEBOUNCE_MS, firstAt + EVENT_MAX_WAIT_MS - Date.now());
      timer = setTimeout(
        () => {
          firstAt = undefined;
          void queryClient.invalidateQueries({ queryKey: queueKeys.all(tenantId) });
        },
        Math.max(0, wait),
      );
    };
    void followEventStream({
      connect: openQueueEvents,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.event !== 'queue') return;
        // An event of another shape is not acted on; nothing in it is shown.
        try {
          const parsed = queueEventSchema.safeParse(JSON.parse(event.data));
          if (!parsed.success) return;
          if (shown.current === '' || parsed.data.departmentId === shown.current) refresh();
        } catch {
          // Not JSON: ignored.
        }
      },
      onStatus: (next) => {
        if (next === 'live') refresh();
        setStatus(next);
      },
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      setStatus('off');
    };
  }, [enabled, tenantId, queryClient]);

  return status;
}
