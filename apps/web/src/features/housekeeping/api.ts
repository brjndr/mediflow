import { api, requireData } from '@/shared/api';
import { cleaningTaskSchema, taskPageSchema, wardBedsSchema, wardOptionsSchema } from './schemas';
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

export interface TaskCreate {
  bedId: string;
  assignedTo?: string;
}

/** Asks for a bed to be cleaned (a routine task). The server refuses a bed that is in use. */
export async function createTask(body: TaskCreate, key: string): Promise<CleaningTask> {
  const result = await api.POST('/cleaning-tasks', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return cleaningTaskSchema.parse(requireData(result));
}

/** The wards to pick a bed from: names and ids only. A hospital has a few dozen at most. */
export async function fetchWardOptions(signal?: AbortSignal) {
  const result = await api.GET('/wards', { params: { query: { limit: 100 } }, signal });
  return wardOptionsSchema.parse(requireData(result)).items;
}

/** The beds of one ward that a cleaning can be asked for (not in use, not blocked). */
export async function fetchWardBeds(wardId: string, signal?: AbortSignal) {
  const result = await api.GET('/wards/{wardId}', { params: { path: { wardId } }, signal });
  const detail = wardBedsSchema.parse(requireData(result));
  return detail.rooms
    .filter((room) => !room.archived)
    .flatMap((room) => room.beds.map((bed) => ({ ...bed, roomName: room.name })))
    .filter((bed) => !bed.archived && bed.status === 'available');
}
