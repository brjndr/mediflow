import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { archiveNotice, fetchNotices } from '../api';

/** Every key is prefixed with the tenant, so one hospital's notices are never shown in another. */
export const noticeKeys = createTenantKeys('notices');

export const NOTICES_PAGE_SIZE = 25;

/** Notices are low-churn: a short stale time avoids refetching on every visit. */
const STALE_TIME_MS = 30_000;

/** The notice list, one server page at a time. The full list is never loaded at once. */
export function useNotices() {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: noticeKeys.list(tenantId ?? '', { limit: NOTICES_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchNotices({ cursor: pageParam, limit: NOTICES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** The newest few notices, for the dashboard widget. */
export function useLatestNotices(count: number) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: noticeKeys.list(tenantId ?? '', { limit: count }),
    queryFn: ({ signal }) => fetchNotices({ limit: count }, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

export function useArchiveNotice() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: archiveNotice,
    onSuccess: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: noticeKeys.lists(tenantId) });
    },
  });
}
