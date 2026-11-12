import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { fetchHolds, placeHold, releaseHold } from '../api';
import { HOLD_PAGE_SIZE } from '../schemas';
import { documentKeys } from './use-documents';

const holdsKey = (tenantId: string) => documentKeys.list(tenantId, { holds: true });

/** The hospital's active legal holds, newest first, a page at a time. */
export function useLegalHolds() {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: holdsKey(tenantId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      fetchHolds({ cursor: pageParam, limit: HOLD_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
  });
}

function useRefreshHolds() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  // Documents too: their held badge follows the holds. Harmless after a switch (the key holds the hospital).
  return () =>
    tenantId === undefined
      ? undefined
      : queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId) });
}

export function usePlaceHold() {
  const refresh = useRefreshHolds();
  return useMutation({
    mutationFn: ({
      target,
      reason,
    }: {
      target: { patientId: string; documentId?: string };
      reason: string;
    }) => placeHold(target, reason),
    onSettled: () => refresh(),
  });
}

export function useReleaseHold() {
  const refresh = useRefreshHolds();
  return useMutation({
    mutationFn: (holdId: string) => releaseHold(holdId),
    onSettled: () => refresh(),
  });
}
