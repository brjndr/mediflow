import { api, requireData } from '@/shared/api';
import { cleaningTaskSchema, taskPageSchema } from './schemas';
import type { CleaningTask, CleaningTaskPage, CleaningTaskStatus } from './types';

/** Oldest first, as the server orders them. */
export async function fetchTasks(
  { status, cursor, limit }: { status: CleaningTaskStatus; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CleaningTaskPage> {
  const result = await api.GET('/cleaning-tasks', {
    params: { query: { status, cursor, limit } },
    signal,
  });
  return taskPageSchema.parse(requireData(result));
}

export interface TaskMove {
  task: CleaningTask;
  to: 'in_progress' | 'done' | 'cancelled';
}

/** Starts, finishes or cancels a task. Finishing makes its bed available on the server. */
export async function moveTask({ task, to }: TaskMove, key: string): Promise<CleaningTask> {
  const result = await api.POST('/cleaning-tasks/{taskId}/move', {
    params: { path: { taskId: task.id }, header: { 'idempotency-key': key } },
    body: { to, version: task.version },
  });
  return cleaningTaskSchema.parse(requireData(result));
}
