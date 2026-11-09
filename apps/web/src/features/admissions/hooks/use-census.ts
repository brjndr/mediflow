import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { fetchAdmissions, fetchBedCount } from '../api';
import { BOARD_STATUSES } from '../schemas';
import { bedKeys } from './use-board';

export const CENSUS_PAGE_SIZE = 50;

/**
 * Beds by status, counted by the bed board's own query, so the census and the board cannot
 * disagree. Kept under the board's keys: the board's events read both again together.
 */
export function useOccupancy(wardId: string, live: boolean) {
  const tenantId = useTenant()?.id;
  return useQueries({
    queries: BOARD_STATUSES.map((status) => ({
      queryKey: bedKeys.list(tenantId ?? '', { view: 'count', wardId, status }),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchBedCount({ wardId, status }, signal),
      enabled: tenantId !== undefined,
      staleTime: live ? Infinity : 0,
    })),
    combine: (results) => ({
      isPending: results.some((result) => result.isPending),
      isError: results.some((result) => result.isError),
      error: results.find((result) => result.error)?.error ?? null,
      counts: BOARD_STATUSES.map((status, index) => ({
        status,
        count: results[index]?.data ?? 0,
      })),
      refetch: () => results.forEach((result) => void result.refetch()),
    }),
  });
}

/** The patients in the hospital now, newest first, of one ward or of every ward. */
export function useAdmittedPatients(wardId: string, live: boolean) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: bedKeys.list(tenantId ?? '', { view: 'census', wardId, limit: CENSUS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchAdmissions(
        { status: 'admitted', wardId, cursor: pageParam, limit: CENSUS_PAGE_SIZE },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: live ? Infinity : 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}
