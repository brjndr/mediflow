import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { fetchAdmissions, fetchBedCounts } from '../api';
import { BOARD_STATUSES } from '../schemas';
import { bedKeys } from './use-board';

export const CENSUS_PAGE_SIZE = 50;

/**
 * Beds by status, from the one counts request, which counts the beds in use as the board lists
 * them. Kept under the board's keys: the board's events read both again together.
 */
export function useOccupancy(wardId: string, live: boolean) {
  const tenantId = useTenant()?.id;
  const query = useQuery({
    queryKey: bedKeys.list(tenantId ?? '', { view: 'count', wardId }),
    queryFn: ({ signal }) => fetchBedCounts({ wardId }, signal),
    enabled: tenantId !== undefined,
    staleTime: live ? Infinity : 0,
  });
  return {
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    counts: BOARD_STATUSES.map((status) => ({
      status,
      count: query.data?.counts.find((each) => each.status === status)?.count ?? 0,
    })),
    refetch: () => void query.refetch(),
  };
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
