import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { bedForAdmission, BEDS_TOPIC, lockWard, moveBed } from '../wards/index.js';
import { isUuid, selectPage } from './page.js';
import {
  CleaningTask,
  CleaningTaskCreate,
  CleaningTaskListQuery,
  CleaningTaskMove,
  CleaningTaskPage,
  CleaningTaskParams,
} from './schemas.js';
import { featureOn, isCode, iso, requireGrant, userIdOf } from './util.js';

const FEATURE = 'housekeeping';

type Status = CleaningTask['status'];
export const CLEANING_TRANSITIONS: Record<Status, readonly Status[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

interface TaskRow {
  id: string;
  tenant_id: string;
  bed_id: string;
  bed_number: string;
  ward_id: string;
  ward_name: string;
  kind: CleaningTask['kind'];
  status: Status;
  assigned_to: string | null;
  assigned_name: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  version: number;
}

const SELECT = `select x.id, x.tenant_id, x.bed_id, b.number as bed_number, x.ward_id,
       w.name as ward_name, x.kind, x.status, x.assigned_to, u.name as assigned_name,
       x.created_at, x.started_at, x.finished_at, x.version
  from cleaning_tasks x
  join beds b on b.tenant_id = x.tenant_id and b.id = x.bed_id
  join wards w on w.tenant_id = x.tenant_id and w.id = x.ward_id
  left join users u on u.id = x.assigned_to`;

const view = (row: TaskRow): CleaningTask => ({
  id: row.id,
  tenantId: row.tenant_id,
  bedId: row.bed_id,
  bedNumber: row.bed_number,
  wardId: row.ward_id,
  wardName: row.ward_name,
  kind: row.kind,
  status: row.status,
  ...(row.assigned_to === null
    ? {}
    : { assignedTo: row.assigned_to, assignedToName: row.assigned_name ?? '' }),
  createdAt: iso(row.created_at),
  ...(row.started_at === null ? {} : { startedAt: iso(row.started_at) }),
  ...(row.finished_at === null ? {} : { finishedAt: iso(row.finished_at) }),
  version: row.version,
});

async function find(client: pg.ClientBase, id: string, lock = false): Promise<TaskRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<TaskRow>(
    `${SELECT} where x.id = $1 ${lock ? 'for update of x' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const notFound = () => new HttpError(404, 'cleaning_task_not_found', 'No such task');

/**
 * A patient leaving a bed (`bed.released`, except a cancelled admission) leaves it being cleaned; this makes the task for it,
 * once. Only for hospitals with housekeeping on, and idempotent: a bed with a task open gets no
 * second one.
 */
export function subscribeToReleasedBeds(app: FastifyInstance): void {
  app.events.subscribe('bed.released', async (message, tx) => {
    const bedId = message.entityId;
    const wardId = message.payload.wardId;
    if (typeof bedId !== 'string' || !isUuid(bedId)) return;
    if (typeof wardId !== 'string' || !isUuid(wardId)) return;
    // An admission cancelled by mistake leaves its bed ready at once: nothing to clean (#573).
    if (message.payload.reason === 'cancelled') return;
    const on = await tx.execute<{ one: number }>(
      sql`select 1 as one from tenant_features where feature = ${FEATURE} and enabled`,
    );
    if (on.rows.length === 0) return;
    await tx.execute(
      sql`insert into cleaning_tasks (bed_id, ward_id, kind)
          values (${bedId}, ${wardId}, 'discharge')
          on conflict (tenant_id, bed_id) where status in ('open', 'in_progress') do nothing`,
    );
  });
}

export const housekeepingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const announce = (
    request: { server: FastifyInstance; txClient: pg.ClientBase },
    wardId: string,
  ) => request.server.live.bus.publish(request.txClient, BEDS_TOPIC, { wardId });

  app.get(
    '/cleaning-tasks',
    {
      config: { permissions: ['cleaningTask:read'], feature: FEATURE },
      schema: {
        operationId: 'listCleaningTasks',
        tags: ['housekeeping'],
        description:
          'Bed cleaning tasks, oldest first, filtered by status or ward. Requires cleaningTask:read.',
        querystring: CleaningTaskListQuery,
        response: { 200: ref(CleaningTaskPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.status) {
        params.push(q.status);
        where.push(`x.status = $${params.length}`);
      }
      if (q.wardId) {
        params.push(q.wardId);
        where.push(`x.ward_id::text = $${params.length}`);
      }
      const page = await selectPage<TaskRow>(request.txClient, {
        select: SELECT,
        where,
        params,
        order: 'x.created_at',
        cursor: q.cursor,
        limit: q.limit ?? DEFAULT_PAGE_SIZE,
      });
      return { items: page.rows.map(view), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/cleaning-tasks',
    {
      config: {
        permissions: ['cleaningTask:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createCleaningTask',
        tags: ['housekeeping'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Asks for a bed to be cleaned (a `routine` task). An available bed is set to being cleaned; one being cleaned already keeps that. An occupied or blocked bed is 409 `bed_not_available`, a bed that already has a task open 409 `task_exists`, an unknown bed 422 `unknown_bed`. `assignedTo` must be a member of the hospital (422 `unknown_user`). Needs the wards module (403 `feature_disabled`). The Idempotency-Key header is required. Audited, announced on `/beds/events`; emits `cleaning.task_created`. Requires cleaningTask:manage.',
        body: CleaningTaskCreate,
        response: { 201: ref(CleaningTask), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (!(await featureOn(request, 'wards'))) {
        throw new HttpError(403, 'feature_disabled', 'The wards module is off');
      }
      const client = request.txClient;
      const body = request.body;
      const probe = await bedForAdmission(client, body.bedId);
      if (!probe) throw new HttpError(422, 'unknown_bed', 'No such bed');
      if (body.assignedTo !== undefined && !isUuid(body.assignedTo)) {
        throw new HttpError(422, 'unknown_user', 'No such member');
      }
      await lockWard(client, probe.ward_id);
      const bed = await bedForAdmission(client, body.bedId);
      if (!bed || bed.archived || (bed.status !== 'available' && bed.status !== 'cleaning')) {
        throw new HttpError(409, 'bed_not_available', 'The bed cannot be cleaned now');
      }
      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into cleaning_tasks (bed_id, ward_id, kind, assigned_to, created_by)
           values ($1, $2, 'routine', $3, $4) returning id`,
          [bed.id, bed.ward_id, body.assignedTo ?? null, userIdOf(request)],
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        if (isCode(error, '23505', 'cleaning_tasks_one_live')) {
          throw new HttpError(409, 'task_exists', 'The bed already has a cleaning task');
        }
        if (isCode(error, '23503', 'cleaning_tasks_assignee')) {
          throw new HttpError(422, 'unknown_user', 'No such member');
        }
        throw error;
      }
      if (bed.status === 'available') {
        await moveBed(client, bed.id, 'available', 'cleaning', null);
        announce(request, bed.ward_id);
      }
      request.audit('create', 'cleaning_task', id);
      await request.emit('cleaning.task_created', id, { bedId: bed.id, wardId: bed.ward_id });
      return reply.status(201).send(view((await find(client, id)) as TaskRow));
    },
  );

  app.post(
    '/cleaning-tasks/:taskId/move',
    {
      config: {
        permissions: ['cleaningTask:read'],
        feature: FEATURE,
        idempotent: { body: 'full' },
      },
      schema: {
        operationId: 'moveCleaningTask',
        tags: ['housekeeping'],
        headers: IdempotencyHeaders,
        description:
          'open -> in_progress (the caller takes an unassigned task) -> done, which makes the bed available if it is still being cleaned; or cancelled before it is done (the bed stays as it is). Starting and finishing need cleaningTask:work, cancelling cleaningTask:manage (403 `permission_denied`). Anything else is 409 `invalid_transition`. Finishing needs the wards module (403 `feature_disabled`). The `version` is the task’s, or 409 `conflict`. Audited, announced on `/beds/events`; emits `cleaning.task_completed` when done. Requires cleaningTask:read.',
        params: CleaningTaskParams,
        body: CleaningTaskMove,
        response: { 200: ref(CleaningTask), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const to = body.to as Status;
      await requireGrant(request, to === 'cancelled' ? 'cleaningTask:manage' : 'cleaningTask:work');
      const probe = await find(client, request.params.taskId);
      if (!probe) throw notFound();
      if (to === 'done') {
        if (!(await featureOn(request, 'wards'))) {
          throw new HttpError(403, 'feature_disabled', 'The wards module is off');
        }
        await lockWard(client, probe.ward_id);
      }
      const task = (await find(client, probe.id, true)) as TaskRow;
      if (task.version !== body.version) {
        throw new HttpError(409, 'conflict', 'The task has changed since it was read');
      }
      if (!CLEANING_TRANSITIONS[task.status].includes(to)) {
        throw new HttpError(409, 'invalid_transition', `Not from ${task.status} to ${to}`);
      }
      const userId = userIdOf(request);
      if (to === 'in_progress') {
        await client.query(
          `update cleaning_tasks set status = 'in_progress', started_at = now(),
                  assigned_to = coalesce(assigned_to, $2) where id = $1`,
          [task.id, userId],
        );
      } else if (to === 'done') {
        await client.query(
          "update cleaning_tasks set status = 'done', finished_at = now() where id = $1",
          [task.id],
        );
        const bed = await bedForAdmission(client, task.bed_id);
        if (
          bed &&
          bed.status === 'cleaning' &&
          (await moveBed(client, bed.id, 'cleaning', 'available', null))
        ) {
          announce(request, bed.ward_id);
        }
        await request.emit('cleaning.task_completed', task.id, {
          bedId: task.bed_id,
          wardId: task.ward_id,
        });
      } else {
        await client.query(
          "update cleaning_tasks set status = 'cancelled', finished_at = now() where id = $1",
          [task.id],
        );
      }
      request.audit('update', 'cleaning_task', task.id);
      return view((await find(client, task.id)) as TaskRow);
    },
  );
};
