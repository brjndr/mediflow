import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  deactivateStaff,
  fetchStaff,
  fetchStaffRoles,
  reactivateStaff,
  resendInvite,
  revokeStaffSessions,
  sendInvite,
  withdrawInvite,
  type StaffFilters,
} from '../api';
import type { InviteRequest, StaffMember } from '../types';

/** Every key is prefixed with the tenant, so one hospital's staff never show in another. */
export const staffKeys = createTenantKeys('staff');

const rolesKey = (tenantId: string) => [...staffKeys.all(tenantId), 'roles'] as const;

/** Role management changed which roles exist: the invite form asks for them again. */
export function invalidateStaffRoles(queryClient: QueryClient, tenantId: string) {
  return queryClient.invalidateQueries({ queryKey: rolesKey(tenantId) });
}

export const STAFF_PAGE_SIZE = 25;

/** Who works here changes rarely, but an admin acts on what the list says: keep it fresh. */
const STALE_TIME_MS = 30_000;

/** The people of the hospital, one server page at a time. */
export function useStaff(filters: StaffFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: staffKeys.list(tenantId ?? '', { ...filters, q, limit: STAFF_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchStaff({ ...filters, q, cursor: pageParam, limit: STAFF_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    // The last page stays while a search is typed, but only of the same view at the same
    // hospital: the actions offered go with the view, and must never meet another view's rows.
    placeholderData: (previous, previousQuery) => {
      const [, previousTenant, , , previousFilters] = previousQuery?.queryKey ?? [];
      const sameView =
        previousTenant === tenantId &&
        (previousFilters as StaffFilters | undefined)?.status === filters.status;
      return sameView ? previous : undefined;
    },
  });
}

/** The roles someone can be invited into. */
export function useStaffRoles() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: rolesKey(tenantId ?? ''),
    queryFn: ({ signal }) => fetchStaffRoles(signal),
    enabled: tenantId !== undefined,
    staleTime: 5 * 60_000,
  });
}

function useRefreshLists() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (tenantId) return queryClient.invalidateQueries({ queryKey: staffKeys.lists(tenantId) });
  };
}

export type StaffAction = 'deactivate' | 'reactivate' | 'revokeSessions' | 'withdraw';

/** What an admin does to one member. Every list is asked for again afterwards. */
export function useStaffAction() {
  const refresh = useRefreshLists();
  return useMutation({
    mutationFn: async ({ action, member }: { action: StaffAction; member: StaffMember }) => {
      if (action === 'deactivate') await deactivateStaff(member.id);
      else if (action === 'reactivate') await reactivateStaff(member.id);
      // For an invitation the id is the invitation's own.
      else if (action === 'withdraw') await withdrawInvite(member.id);
      else await revokeStaffSessions(member.id);
      return { action, member };
    },
    onSettled: refresh,
  });
}

/** Sends one invitation. */
export function useSendInvite() {
  const refresh = useRefreshLists();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: InviteRequest; idempotencyKey: string }) =>
      sendInvite(body, idempotencyKey),
    onSettled: refresh,
  });
}

/** Sends an open invitation again. Every list is asked for again, so its email status is fresh. */
export function useResendInvite() {
  const refresh = useRefreshLists();
  return useMutation({
    mutationFn: ({ inviteId, idempotencyKey }: { inviteId: string; idempotencyKey: string }) =>
      resendInvite(inviteId, idempotencyKey),
    onSettled: refresh,
  });
}
