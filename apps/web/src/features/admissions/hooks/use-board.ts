import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createTenantKeys, followEventStream, type EventStreamStatus } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  changeBed,
  fetchBoard,
  fetchWardOptions,
  openBedEvents,
  type BedAction,
  type BoardFilters,
} from '../api';
import { bedEventSchema } from '../schemas';

/** Every key is prefixed with the tenant, so one hospital's beds never show in another. */
export const bedKeys = createTenantKeys('beds');

export const BOARD_PAGE_SIZE = 50;

/** While the event stream is down the board reads the beds on its own, this often. */
export const FALLBACK_REFRESH_MS = 15_000;

/** Events that come close together are one refresh. */
const EVENT_DEBOUNCE_MS = 300;
/** ...but a steady flow of events still refreshes the board at least this often. */
const EVENT_MAX_WAIT_MS = 1_000;

/** The beds, one server page at a time. */
export function useBoard(filters: BoardFilters, live: boolean) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: bedKeys.list(tenantId ?? '', { ...filters, limit: BOARD_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchBoard({ ...filters, cursor: pageParam, limit: BOARD_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    // Events say when it changed; without them it is read again on a timer.
    staleTime: live ? Infinity : 0,
    refetchInterval: live ? false : FALLBACK_REFRESH_MS,
    // The previous filter's rows while the next come, never another hospital's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** The wards to filter by. Without `ward:read` the filter is left out (`available` is false). */
export function useWardOptions(enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bedKeys.detail(tenantId ?? '', 'wards'),
    queryFn: ({ signal }) => fetchWardOptions(signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Cleaning, ready, block and unblock. Not shown before the server answers: another desk may
 * have changed the bed first (409), and the board is read again whatever the answer.
 */
export function useBedAction() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (action: BedAction) => {
      // One key per request: an identical resubmit is done once.
      const body = JSON.stringify({ ...action, bed: [action.bed.id, action.bed.version] });
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return changeBed(action, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: bedKeys.all(tenantId) });
    },
  });
}

/**
 * Follows the hospital's bed events while the screen is open and reads the board again when one
 * says a ward changed. Closed on leaving the screen, on a switch of hospital and on sign-out.
 * Each time it opens the board is read once, for what changed while it was not open. A board
 * shown for one ward (`wardId`) refreshes only for that ward's events.
 */
export function useBedEvents(enabled: boolean, wardId: string): EventStreamStatus | 'off' {
  const tenantId = useTenant()?.id;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventStreamStatus | 'off'>('off');
  const shown = useRef(wardId);
  useEffect(() => {
    shown.current = wardId;
  }, [wardId]);

  useEffect(() => {
    if (!enabled || tenantId === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstAt: number | undefined;
    const refresh = () => {
      clearTimeout(timer);
      firstAt ??= Date.now();
      const wait = Math.min(EVENT_DEBOUNCE_MS, firstAt + EVENT_MAX_WAIT_MS - Date.now());
      timer = setTimeout(
        () => {
          firstAt = undefined;
          void queryClient.invalidateQueries({ queryKey: bedKeys.lists(tenantId) });
        },
        Math.max(0, wait),
      );
    };
    void followEventStream({
      connect: openBedEvents,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.event !== 'beds') return;
        try {
          const parsed = bedEventSchema.safeParse(JSON.parse(event.data));
          if (!parsed.success) return;
          if (shown.current === '' || parsed.data.wardId === shown.current) refresh();
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
