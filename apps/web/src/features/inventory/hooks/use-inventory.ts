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
import { useTenant } from '@/tenancy';
import {
  approveAdjustment,
  createAdjustment,
  createLocation,
  fetchAdjustments,
  fetchAlertCounts,
  fetchLedger,
  fetchLocations,
  fetchStock,
  rejectAdjustment,
  setLocationArchived,
  updateLocation,
  type LedgerFilters,
  type StockFilters,
} from '../api';
import type {
  StockAdjustment,
  StockAdjustmentCreate,
  StockAdjustmentStatus,
  StockLocation,
  StockLocationKind,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's stock never shows in another. */
export const inventoryKeys = createTenantKeys('inventory');

export const PAGE_SIZE = 25;
/** Places are few: one page fills a filter's list. */
export const LOCATIONS_IN_A_LIST = 100;

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

/** Whatever the answer, everything of inventory is read again: stock, ledger and adjustments. */
function useRefresh() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: inventoryKeys.all(tenantId) });
  };
}

function usePaged<Page extends { nextCursor: string | null }, Filters extends object>(
  name: string,
  filters: Filters,
  fetchPage: (
    request: Filters & { cursor?: string; limit: number },
    signal: AbortSignal,
  ) => Promise<Page>,
  limit = PAGE_SIZE,
  enabled = true,
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: inventoryKeys.list(tenantId ?? '', { name, ...filters, limit }),
    queryFn: ({ pageParam, signal }) => fetchPage({ ...filters, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: enabled && tenantId !== undefined,
  });
}

/** The items with their stock, a page at a time; asked for only while `enabled`. */
export const useStock = (filters: StockFilters, enabled = true) =>
  usePaged('stock', filters, fetchStock, PAGE_SIZE, enabled);

export const useLedger = (filters: LedgerFilters) => usePaged('ledger', filters, fetchLedger);

export const useAdjustments = (status: StockAdjustmentStatus) =>
  usePaged('adjustments', { status }, fetchAdjustments);

export const useLocations = (archived: boolean) =>
  usePaged('locations', { archived }, fetchLocations, LOCATIONS_IN_A_LIST);

/** The places in use, for a filter or a form's list. */
export function usePlaces(): StockLocation[] {
  const places = useLocations(false);
  return useMemo(() => places.data?.pages.flatMap((page) => page.items) ?? [], [places.data]);
}

export function useAlertCounts(filters: Pick<StockFilters, 'locationId' | 'expiringWithinDays'>) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: inventoryKeys.list(tenantId ?? '', { name: 'alerts', ...filters }),
    queryFn: ({ signal }) => fetchAlertCounts(filters, signal),
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

export function useCreateAdjustment() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: StockAdjustmentCreate) => createAdjustment(body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** Approves or rejects a pending adjustment at the version it was read at. */
export function useDecideAdjustment() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ adjustment, note }: { adjustment: StockAdjustment; note?: string }) => {
      const expectedVersion = adjustment.version;
      if (note === undefined) {
        const body = { expectedVersion };
        return approveAdjustment(adjustment.id, body, keys.keyFor({ id: adjustment.id, ...body }));
      }
      const body = { expectedVersion, note };
      return rejectAdjustment(adjustment.id, body, keys.keyFor({ id: adjustment.id, ...body }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useSaveLocation() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    mutationFn: ({
      location,
      values,
    }: {
      location: StockLocation | null;
      values: { name: string; kind: StockLocationKind };
    }) =>
      location
        ? updateLocation(location.id, { expectedVersion: location.version, ...values })
        : createLocation(values, keys.keyFor(values)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useArchiveLocation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ location, archived }: { location: StockLocation; archived: boolean }) =>
      setLocationArchived(location.id, archived),
    onSettled: refresh,
  });
}
