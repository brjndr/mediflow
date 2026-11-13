import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { useFeatureFlag, usePermission } from '@/access';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { dayBoundsUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import {
  cancelShift,
  copyWeek,
  createShift,
  createTemplate,
  fetchTemplates,
  retireTemplate,
  swapShift,
  fetchLeaves,
  fetchShifts,
  moveLeave,
  requestLeave,
  type LeaveMove,
  type ShiftFilters,
} from '../api';
import { ROSTER_PAGE_SIZE } from '../schemas';
import type { CopyWeekBody, RosterShiftCreate, ShiftSwapBody, ShiftTemplateCreate } from '../types';

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

/** Roster read access and the switch, the two things every leave lookup for another screen needs. */
function useRosterAvailable() {
  const allowed = usePermission('roster:read');
  const switchedOn = useFeatureFlag('roster');
  return allowed && switchedOn;
}

/**
 * Approved leave that overlaps a window (one page of 100, a hospital's leave in a week or a day).
 * Only approved leave counts: a request waiting for a decision does not make anyone unavailable.
 * `available` is false without `roster:read` or with the roster off: nothing is asked for then.
 */
export function useApprovedLeaves(window: { from: string; to: string } | undefined) {
  const tenantId = useTenant()?.id;
  const available = useRosterAvailable();
  const query = useQuery({
    queryKey: rosterKeys.list(tenantId ?? '', { as: 'approved_leaves', ...window }),
    queryFn: async ({ signal }) =>
      (
        await fetchLeaves(
          {
            ...(window as { from: string; to: string }),
            status: 'approved',
            limit: ROSTER_PAGE_SIZE,
          },
          signal,
        )
      ).items,
    enabled: available && tenantId !== undefined && window !== undefined,
    staleTime: 30_000,
  });
  return { ...query, available };
}

/**
 * Whether one member of staff (a doctor's `userId`) is on approved leave on a calendar day of the
 * hospital's clock, for scheduling to say so. `leave` is undefined when not, or when unknown.
 */
export function useLeaveOnDay(userId: string | undefined, day: string | undefined) {
  const timezone = useTenant()?.timezone ?? 'UTC';
  const window = useMemo(() => {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
    const bounds = dayBoundsUtc(day, timezone);
    return { from: bounds.start, to: bounds.end };
  }, [day, timezone]);
  const leaves = useApprovedLeaves(userId ? window : undefined);
  return { leave: leaves.data?.find((one) => one.userId === userId), available: leaves.available };
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
  const available = useRosterAvailable();
  const query = useQuery({
    queryKey: rosterKeys.list(tenantId ?? '', { as: 'on_call_now', departmentId }),
    queryFn: async ({ signal }) => {
      const now = new Date();
      const window = { from: now.toISOString(), to: new Date(now.getTime() + 1000).toISOString() };
      const [page, leaves] = await Promise.all([
        fetchShifts({ ...window, departmentId, limit: ROSTER_PAGE_SIZE }, signal),
        fetchLeaves({ ...window, status: 'approved', limit: ROSTER_PAGE_SIZE }, signal),
      ]);
      // Nobody on approved leave right now is on call, whatever an old shift says.
      const away = new Set(leaves.items.map((one) => one.userId));
      return page.items.filter((shift) => !away.has(shift.userId));
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

/** Leaves that have not ended yet, oldest first (`from` is read once, so the key is stable). */
export function useLeaves() {
  const tenantId = useTenant()?.id;
  const from = useMemo(() => new Date().toISOString(), []);
  return useInfiniteQuery({
    queryKey: rosterKeys.list(tenantId ?? '', { as: 'leaves', limit: ROSTER_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchLeaves({ cursor: pageParam, limit: ROSTER_PAGE_SIZE, from }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
  });
}

export function useRequestLeave() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: { startsAt: string; endsAt: string }) => {
      const made = await requestLeave(body, attempt.keyFor(body));
      attempt.done();
      return made;
    },
    onSuccess: () => {
      const tenantId = stillHere();
      if (tenantId) void queryClient.invalidateQueries({ queryKey: rosterKeys.all(tenantId) });
    },
  });
}

export function useMoveLeave() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async ({
      leaveId,
      move,
      version,
    }: {
      leaveId: string;
      move: LeaveMove;
      version: number;
    }) => {
      const moved = await moveLeave(
        move,
        leaveId,
        version,
        attempt.keyFor({ move, leaveId, version }),
      );
      attempt.done();
      return moved;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) void queryClient.invalidateQueries({ queryKey: rosterKeys.all(tenantId) });
    },
  });
}

/** The hospital's live shift templates (one page of 100; a hospital keeps a handful). */
export function useShiftTemplates() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: rosterKeys.list(tenantId ?? '', { as: 'templates' }),
    queryFn: async ({ signal }) =>
      (await fetchTemplates({ limit: ROSTER_PAGE_SIZE }, signal)).items,
    enabled: tenantId !== undefined,
    staleTime: 30_000,
  });
}

/** A write that refreshes the roster either way, with one key for one identical request. */
function useRosterWrite<Input, Output>(run: (input: Input, key: string) => Promise<Output>) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (input: Input) => {
      const done = await run(input, attempt.keyFor(input));
      attempt.done();
      return done;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) void queryClient.invalidateQueries({ queryKey: rosterKeys.all(tenantId) });
    },
  });
}

export const useCreateTemplate = () =>
  useRosterWrite((body: ShiftTemplateCreate, key) => createTemplate(body, key));

export const useRetireTemplate = () =>
  useRosterWrite(({ templateId, version }: { templateId: string; version: number }, key) =>
    retireTemplate(templateId, version, key),
  );

export const useCopyWeek = () => useRosterWrite((body: CopyWeekBody, key) => copyWeek(body, key));

export const useSwapShift = () =>
  useRosterWrite(({ shiftId, body }: { shiftId: string; body: ShiftSwapBody }, key) =>
    swapShift(shiftId, body, key),
  );
