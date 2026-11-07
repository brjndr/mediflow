import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchTasks, moveTask, type TaskMove } from '../api';
import type { CleaningTaskStatus } from '../types';

/** Every key is prefixed with the tenant, so one hospital's tasks never show in another. */
export const taskKeys = createTenantKeys('cleaning-tasks');

export const TASK_PAGE_SIZE = 50;

/** The list is read again this often: others work the same tasks. */
export const REFRESH_MS = 15_000;

export function useTasks(status: CleaningTaskStatus) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: taskKeys.list(tenantId ?? '', { status, limit: TASK_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchTasks({ status, cursor: pageParam, limit: TASK_PAGE_SIZE }, signal),
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
