import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { changeMockBed } from './admissions';

type CleaningTask = components['schemas']['CleaningTask'];
type Status = CleaningTask['status'];

const FEATURE_FLAG = 'housekeeping';

const MOVES: Record<Status, Status[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

const seed = (): CleaningTask[] => [
  {
    id: 'task_1',
    tenantId: TENANT_IDS.hospital,
    bedId: 'ward_h_gw-a_b3',
    bedNumber: 'GW-A-03',
    wardId: 'ward_h_gw-a',
    wardName: 'General Ward A',
    kind: 'discharge',
    status: 'open',
    createdAt: '2026-11-07T09:00:00.000Z',
    version: 1,
  },
];

let tasks = seed();
onMockReset(() => {
  tasks = seed();
});

/** For tests: a patient leaves a bed and the server makes its cleaning task. */
export function addMockCleaningTask(task: Partial<CleaningTask> & { id: string }): void {
  tasks.push({
    tenantId: TENANT_IDS.hospital,
    bedId: 'ward_h_gw-a_b3',
    bedNumber: 'GW-A-03',
    wardId: 'ward_h_gw-a',
    wardName: 'General Ward A',
    kind: 'discharge',
    status: 'open',
    createdAt: '2026-11-07T10:00:00.000Z',
    version: 1,
    ...task,
  });
}

const STATUSES: Status[] = ['open', 'in_progress', 'done', 'cancelled'];

export const housekeepingHandlers = [
  http.get('*/api/cleaning-tasks', ({ request }) => {
    const access = authorize(request, {
      permission: 'cleaningTask:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const status = query.get('status');
    if (status !== null && !STATUSES.includes(status as Status)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const all = tasks.filter(
      (task) => task.tenantId === access.tenantId && (!status || task.status === status),
    );
    const start = cursor ? all.findIndex((task) => task.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    return HttpResponse.json({
      items: all.slice(start, start + limit),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: all.length }),
    });
  }),

  http.post('*/api/cleaning-tasks/:taskId/move', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'cleaningTask:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body: unknown = await request.json().catch(() => null);
    const { to, version } = (body ?? {}) as { to?: unknown; version?: unknown };
    if (
      (to !== 'in_progress' && to !== 'done' && to !== 'cancelled') ||
      typeof version !== 'number'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    // Working a task and cancelling it are different permissions, as on the server.
    const needed = to === 'cancelled' ? 'cleaningTask:manage' : 'cleaningTask:work';
    const grant = authorize(request, { permission: needed, featureFlag: FEATURE_FLAG });
    if ('denied' in grant) return error(403, 'permission_denied', `Missing ${needed}`);
    const task = tasks.find((t) => t.id === params.taskId && t.tenantId === access.tenantId);
    if (!task) return error(404, 'cleaning_task_not_found', 'No such task');
    if (task.version !== version) return error(409, 'conflict', 'It has changed');
    if (!MOVES[task.status].includes(to)) {
      return error(409, 'invalid_transition', 'That move is not allowed');
    }
    const now = new Date().toISOString();
    Object.assign(task, {
      status: to,
      version: task.version + 1,
      ...(to === 'in_progress' ? { startedAt: now } : {}),
      ...(to === 'done' ? { finishedAt: now } : {}),
    });
    // Finishing makes the bed available again.
    if (to === 'done') changeMockBed(access.tenantId, task.bedId, task.wardId, 'available');
    return HttpResponse.json<CleaningTask>(task);
  }),
];
