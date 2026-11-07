import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { useFeatureFlag, usePermission } from '@/access';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { cancelShift, createShift, fetchShifts, type ShiftFilters } from '../api';
import { ROSTER_PAGE_SIZE } from '../schemas';
import type { RosterShiftCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's roster never shows in another. */
export const rosterKeys = createTenantKeys('roster');

function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  };
}

/** One key for one identical body: a second tap after a slow answer is the same request. */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    keyFor: (body: unknown) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    done: () => {
      attempt.current = undefined;
    },
  };
}

export function useShifts(filters: ShiftFilters) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: rosterKeys.list(tenantId ?? '', { ...filters, limit: ROSTER_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchShifts({ ...filters, cursor: pageParam, limit: ROSTER_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

export function useCreateShift() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: RosterShiftCreate) => {
      const created = await createShift(body, attempt.keyFor(body));
      attempt.done();
      return created;
    },
    onSuccess: () => {
      const tenantId = stillHere();
      if (tenantId) void queryClient.invalidateQueries({ queryKey: rosterKeys.all(tenantId) });
    },
  });
}

export function useCancelShift(shiftId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (version: number) => {
      const cancelled = await cancelShift(shiftId, version, attempt.keyFor({ shiftId, version }));
      attempt.done();
      return cancelled;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) void queryClient.invalidateQueries({ queryKey: rosterKeys.all(tenantId) });
    },
  });
}

export interface OnCallPerson {
  userId: string;
  name: string;
  departmentId?: string;
  departmentName?: string;
  endsAt: string;
}

/**
 * Who is on call at this moment, from the scheduled `on_call` shifts that cover it, for another
 * screen (scheduling) to show. `available` is false without `roster:read` or with the roster
 * switched off: nothing is asked for then. Refreshed every minute.
 */
export function useOnCallNow(departmentId?: string) {
  const tenantId = useTenant()?.id;
  const allowed = usePermission('roster:read');
  const switchedOn = useFeatureFlag('roster');
  const available = allowed && switchedOn;
  const query = useQuery({
    queryKey: rosterKeys.list(tenantId ?? '', { as: 'on_call_now', departmentId }),
    queryFn: async ({ signal }) => {
      const now = new Date();
      const page = await fetchShifts(
        {
          from: now.toISOString(),
          to: new Date(now.getTime() + 1000).toISOString(),
          departmentId,
          limit: ROSTER_PAGE_SIZE,
        },
        signal,
      );
      return page.items;
    },
    enabled: available && tenantId !== undefined,
    staleTime: 30_000,
    refetchInterval: 60_000,
    select: (shifts): OnCallPerson[] =>
      shifts
        .filter((shift) => shift.shiftKind === 'on_call' && shift.status === 'scheduled')
        .map((shift) => ({
          userId: shift.userId,
          name: shift.userName,
          ...(shift.departmentId === undefined
            ? {}
            : { departmentId: shift.departmentId, departmentName: shift.departmentName }),
          endsAt: shift.endsAt,
        })),
  });
  return { ...query, available };
}
