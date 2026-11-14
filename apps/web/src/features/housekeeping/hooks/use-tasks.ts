import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createTask,
  fetchTasks,
  fetchWardBeds,
  fetchWardOptions,
  moveTask,
  type TaskCreate,
  type TaskMove,
} from '../api';
import type { CleaningTaskStatus } from '../types';

/** Every key is prefixed with the tenant, so one hospital's tasks never show in another. */
export const taskKeys = createTenantKeys('cleaning-tasks');

export const TASK_PAGE_SIZE = 50;

/** The list is read again this often: others work the same tasks. */
export const REFRESH_MS = 15_000;

/** `wardId` empty means every ward. */
export function useTasks(status: CleaningTaskStatus, wardId = '') {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: taskKeys.list(tenantId ?? '', { status, wardId, limit: TASK_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchTasks(
        { status, wardId: wardId || undefined, cursor: pageParam, limit: TASK_PAGE_SIZE },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** Not shown before the server answers: another person may have moved the task first (409). */
export function useMoveTask() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (move: TaskMove) => {
      const body = JSON.stringify([move.task.id, move.task.version, move.to]);
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return moveTask(move, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: taskKeys.all(tenantId) });
    },
  });
}

export function useWardOptions(enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: taskKeys.detail(tenantId ?? '', 'wards'),
    queryFn: ({ signal }) => fetchWardOptions(signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/** A bed's status changes all day, so a ward's beds are read again each time the form opens. */
export function useRequestableBeds(wardId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: taskKeys.detail(tenantId ?? '', `beds:${wardId}`),
    queryFn: ({ signal }) => fetchWardBeds(wardId, signal),
    enabled: wardId !== '' && tenantId !== undefined,
    staleTime: 0,
  });
}

/** One key per request body, so a double click or a retry asks once. */
export function useCreateTask() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (body: TaskCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createTask(body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: taskKeys.all(tenantId) });
    },
  });
}
