import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import {
  CopyWeekBody,
  CopyWeekResult,
  ShiftSwapBody,
  ShiftSwapResult,
  ShiftParams,
  ShiftTemplate,
  ShiftTemplateCreate,
  ShiftTemplateListQuery,
  ShiftTemplatePage,
  TemplateParams,
  VersionBody,
  type RosterShift,
} from './schemas.js';
import { isCode, userIdOf, uuidOr404 } from './util.js';
import { shiftView, SHIFT_SELECT, type ShiftRow } from './roster.js';

/**
 * Planning the roster ahead (#592): a hospital's own shift templates, a week copied forward
 * (once or for several weeks), and swaps (a shift handed to someone else, or two exchanged).
 * Shifts stay add-and-cancel records; a swap cancels the old shift and schedules a new one that
 * points at it.
 */

const FEATURE = 'roster';
const DAY = 24 * 3_600_000;
const WEEK = 7 * DAY;
/** Most source shifts in a week, and most shifts one copy may make. */
const MAX_SOURCE = 300;
const MAX_COPIES = 1000;

interface TemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  shift_kind: ShiftTemplate['shiftKind'];
  start_time: string;
  end_time: string;
  department_id: string | null;
  department_name: string | null;
  active: boolean;
  version: number;
}

const TEMPLATE_SELECT = `select x.id, x.tenant_id, x.name, x.shift_kind, x.start_time, x.end_time,
       x.department_id, d.name as department_name, x.active, x.version, x.created_at
  from roster_shift_templates x
  left join departments d on d.tenant_id = x.tenant_id and d.id = x.department_id`;

const templateView = (row: TemplateRow): ShiftTemplate => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  shiftKind: row.shift_kind,
  startTime: row.start_time,
  endTime: row.end_time,
  ...(row.department_id === null
    ? {}
    : { departmentId: row.department_id, departmentName: row.department_name ?? '' }),
  active: row.active,
  version: row.version,
});

interface SourceRow {
  id: string;
  user_id: string;
  user_name: string;
  department_id: string | null;
  shift_kind: string;
  starts_at: Date;
  ends_at: Date;
}

const INSERT_SHIFT = `insert into roster_shifts
  (user_id, department_id, shift_kind, starts_at, ends_at, created_by, replaces_shift_id)
  values ($1, $2, $3, $4, $5, $6, $7) returning id`;

/** Said once, for a shift refused by the database's own rules; null when it is something else. */
function refusal(error: unknown): HttpError | null {
  if (isCode(error, '23P01', 'roster_shift_on_leave')) {
    return new HttpError(409, 'on_leave', 'The person is on approved leave then');
  }
  if (isCode(error, '23P01')) {
    return new HttpError(409, 'shift_overlap', 'The person is already on duty then');
  }
  if (isCode(error, '23503', 'roster_shifts_member')) {
    return new HttpError(422, 'unknown_user', 'No such member');
  }
  return null;
}

export const rosterPlanRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const findTemplate = async (client: pg.ClientBase, id: string) =>
    (await client.query<TemplateRow>(`${TEMPLATE_SELECT} where x.id = $1`, [id])).rows[0] ?? null;
  const findShift = async (client: pg.ClientBase, id: string) =>
    (await client.query<ShiftRow>(`${SHIFT_SELECT} where x.id = $1`, [id])).rows[0] ?? null;

  // --- templates -------------------------------------------------------------------------------

  app.get(
    '/roster/templates',
    {
      config: { permissions: ['roster:read'], feature: FEATURE },
      schema: {
        operationId: 'listShiftTemplates',
        tags: ['roster'],
        description:
          'The hospital’s shift templates, oldest first; retired ones are left out unless `includeInactive`. Requires roster:read.',
        querystring: ShiftTemplateListQuery,
        response: { 200: ref(ShiftTemplatePage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const page = await selectPage<TemplateRow>(request.txClient, {
        select: TEMPLATE_SELECT,
        where: q.includeInactive === true ? [] : ['x.active'],
        params: [],
        order: 'x.created_at',
        cursor: q.cursor,
        limit: q.limit ?? DEFAULT_PAGE_SIZE,
      });
      return { items: page.rows.map(templateView), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/roster/templates',
    {
      config: {
        permissions: ['roster:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createShiftTemplate',
        tags: ['roster'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Keeps a named shift template: the kind, the hours on the hospital’s clock (an end at or before the start runs into the next day) and an optional department. Two live templates cannot share a name (409 `template_exists`); the hours differ (422 `invalid_period`); 422 `unknown_department`. Audited. Requires roster:manage.',
        body: ShiftTemplateCreate,
        response: { 201: ref(ShiftTemplate), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.startTime === body.endTime) {
        throw new HttpError(422, 'invalid_period', 'A shift has hours');
      }
      if (body.departmentId !== undefined && !isUuid(body.departmentId)) {
        throw new HttpError(422, 'unknown_department', 'No such department');
      }
      let id: string;
      try {
        const { rows } = await request.txClient.query<{ id: string }>(
          `insert into roster_shift_templates
             (name, shift_kind, start_time, end_time, department_id, created_by)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [
            body.name.trim(),
            body.shiftKind,
            body.startTime,
            body.endTime,
            body.departmentId ?? null,
            userIdOf(request),
          ],
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        if (isCode(error, '23505', 'roster_templates_name')) {
          throw new HttpError(409, 'template_exists', 'A template has that name');
        }
        if (isCode(error, '23503', 'roster_templates_department')) {
          throw new HttpError(422, 'unknown_department', 'No such department');
        }
        throw error;
      }
      request.audit('create', 'roster_shift_template', id);
      return reply
        .status(201)
        .send(templateView((await findTemplate(request.txClient, id)) as TemplateRow));
    },
  );

  app.post(
    '/roster/templates/:templateId/retire',
    {
      config: { permissions: ['roster:manage'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'retireShiftTemplate',
        tags: ['roster'],
        headers: IdempotencyHeaders,
        description:
          'Retires a template, once; shifts already made from it stay. The `version` is the template’s, or 409 `conflict`; one already retired is 409 `invalid_transition`. Audited. Requires roster:manage.',
        params: TemplateParams,
        body: VersionBody,
        response: { 200: ref(ShiftTemplate), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.templateId, 'template_not_found', 'No such template');
      const row = await findTemplate(request.txClient, id);
      if (!row) throw new HttpError(404, 'template_not_found', 'No such template');
      if (row.version !== request.body.version) {
        throw new HttpError(409, 'conflict', 'The template has changed since it was read');
      }
      if (!row.active) {
        throw new HttpError(409, 'invalid_transition', 'The template is already retired');
      }
      await request.txClient.query(
        'update roster_shift_templates set active = false where id = $1',
        [id],
      );
      request.audit('update', 'roster_shift_template', id);
      return templateView((await findTemplate(request.txClient, id)) as TemplateRow);
    },
  );

  // --- copy a week forward ---------------------------------------------------------------------

  app.post(
    '/roster/copy-week',
    {
      config: {
        permissions: ['roster:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'copyRosterWeek',
        tags: ['roster'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Copies the scheduled shifts that start in the seven days from `fromStart` into `weeks` (1 to 12) consecutive weeks from `toStart`, each shifted by whole days, the same people, kinds and departments. A shift whose person is already on duty then or on approved leave is skipped and listed, the rest are made. `toStart` is a whole number of days from `fromStart` and no copied week overlaps the source week (422 `invalid_period`); a week of more than 300 shifts or a copy of more than 1000 is 422 `too_many_shifts`. The Idempotency-Key header is required. Audited; each shift emits `roster.shift_scheduled`. Requires roster:manage.',
        body: CopyWeekBody,
        response: { 200: ref(CopyWeekResult), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body;
      const from = Date.parse(body.fromStart);
      const to = Date.parse(body.toStart);
      const weeks = body.weeks ?? 1;
      const delta = to - from;
      if (!Number.isFinite(delta) || delta % DAY !== 0) {
        throw new HttpError(422, 'invalid_period', 'The weeks are a whole number of days apart');
      }
      const offsets = Array.from({ length: weeks }, (_, k) => delta + k * WEEK);
      if (offsets.some((offset) => Math.abs(offset) < WEEK)) {
        throw new HttpError(422, 'invalid_period', 'A week cannot be copied onto itself');
      }
      if (body.departmentId !== undefined && !isUuid(body.departmentId)) {
        throw new HttpError(422, 'unknown_department', 'No such department');
      }
      const client = request.txClient;
      const params: unknown[] = [new Date(from), new Date(from + WEEK)];
      let department = '';
      if (body.departmentId !== undefined) {
        params.push(body.departmentId);
        department = ' and s.department_id = $3';
      }
      const { rows: sources } = await client.query<SourceRow>(
        `select s.id, s.user_id, u.name as user_name, s.department_id, s.shift_kind, s.starts_at, s.ends_at
           from roster_shifts s join users u on u.id = s.user_id
          where s.status = 'scheduled' and s.starts_at >= $1 and s.starts_at < $2${department}
          order by s.starts_at, s.id limit ${MAX_SOURCE + 1}`,
        params,
      );
      if (sources.length > MAX_SOURCE || sources.length * weeks > MAX_COPIES) {
        throw new HttpError(422, 'too_many_shifts', 'Too many shifts to copy at once');
      }
      const actor = userIdOf(request);
      let copied = 0;
      const skipped: CopyWeekResult['skipped'] = [];
      for (const offset of offsets) {
        for (const source of sources) {
          const startsAt = new Date(source.starts_at.getTime() + offset);
          await client.query('savepoint copy_shift');
          try {
            const { rows } = await client.query<{ id: string }>(INSERT_SHIFT, [
              source.user_id,
              source.department_id,
              source.shift_kind,
              startsAt,
              new Date(source.ends_at.getTime() + offset),
              actor,
              null,
            ]);
            await client.query('release savepoint copy_shift');
            const id = (rows[0] as { id: string }).id;
            copied += 1;
            request.audit('create', 'roster_shift', id);
            await request.emit('roster.shift_scheduled', id, {
              userId: source.user_id,
              departmentId: source.department_id,
              shiftKind: source.shift_kind,
              startsAt: startsAt.toISOString(),
              endsAt: new Date(source.ends_at.getTime() + offset).toISOString(),
            });
          } catch (error) {
            await client.query('rollback to savepoint copy_shift');
            const said = refusal(error);
            if (!said || said.code === 'unknown_user') throw said ?? error;
            skipped.push({
              shiftId: source.id,
              userName: source.user_name,
              startsAt: startsAt.toISOString(),
              reason: said.code === 'on_leave' ? 'on_leave' : 'shift_overlap',
            });
          }
        }
      }
      return { copied, skipped };
    },
  );

  // --- swaps -----------------------------------------------------------------------------------

  const schedule = async (
    request: FastifyRequest,
    row: ShiftRow,
    userId: string,
  ): Promise<RosterShift> => {
    const { rows } = await request.txClient.query<{ id: string }>(INSERT_SHIFT, [
      userId,
      row.department_id,
      row.shift_kind,
      row.starts_at,
      row.ends_at,
      userIdOf(request),
      row.id,
    ]);
    const id = (rows[0] as { id: string }).id;
    request.audit('create', 'roster_shift', id);
    await request.emit('roster.shift_scheduled', id, {
      userId,
      departmentId: row.department_id,
      shiftKind: row.shift_kind,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      replacesShiftId: row.id,
    });
    return shiftView((await findShift(request.txClient, id)) as ShiftRow);
  };

  const cancel = async (request: FastifyRequest, row: ShiftRow) => {
    await request.txClient.query("update roster_shifts set status = 'cancelled' where id = $1", [
      row.id,
    ]);
    request.audit('update', 'roster_shift', row.id);
    await request.emit('roster.shift_cancelled', row.id, { userId: row.user_id });
  };

  app.post(
    '/roster/shifts/:shiftId/swap',
    {
      config: {
        permissions: ['roster:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'swapRosterShift',
        tags: ['roster'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Hands a scheduled shift to another member (`userId`), or exchanges it with another person’s scheduled shift (`withShiftId` and its `withVersion`). The old shift is cancelled and a new one is scheduled for the new person, pointing at it; all or nothing. Give `userId` or `withShiftId`, not both and not neither (422 `invalid_swap`), and not the same person (422 `invalid_swap`). 409 `conflict` for a stale version, 409 `invalid_transition` for a shift that is cancelled, 409 `shift_overlap` and `on_leave` when the new person cannot take it, 422 `unknown_user`. Audited; emits `roster.shift_cancelled` and `roster.shift_scheduled`. Requires roster:manage.',
        params: ShiftParams,
        body: ShiftSwapBody,
        response: { 200: ref(ShiftSwapResult), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body;
      const id = uuidOr404(request.params.shiftId, 'shift_not_found', 'No such shift');
      const client = request.txClient;
      const row = await findShift(client, id);
      if (!row) throw new HttpError(404, 'shift_not_found', 'No such shift');
      if (row.version !== body.version) {
        throw new HttpError(409, 'conflict', 'The shift has changed since it was read');
      }
      if (row.status !== 'scheduled') {
        throw new HttpError(409, 'invalid_transition', 'The shift is cancelled');
      }
      if ((body.userId === undefined) === (body.withShiftId === undefined)) {
        throw new HttpError(422, 'invalid_swap', 'Name a person, or a shift to exchange with');
      }
      try {
        if (body.userId !== undefined) {
          if (!isUuid(body.userId)) throw new HttpError(422, 'unknown_user', 'No such member');
          if (body.userId === row.user_id) {
            throw new HttpError(422, 'invalid_swap', 'The shift is already theirs');
          }
          await cancel(request, row);
          return { created: [await schedule(request, row, body.userId)] };
        }
        const otherId = uuidOr404(body.withShiftId as string, 'shift_not_found', 'No such shift');
        const other = await findShift(client, otherId);
        if (!other || other.id === row.id) {
          throw new HttpError(404, 'shift_not_found', 'No such shift');
        }
        if (body.withVersion === undefined) {
          throw new HttpError(422, 'invalid_swap', 'The other shift’s version is needed');
        }
        if (other.version !== body.withVersion) {
          throw new HttpError(409, 'conflict', 'The other shift has changed since it was read');
        }
        if (other.status !== 'scheduled') {
          throw new HttpError(409, 'invalid_transition', 'The other shift is cancelled');
        }
        if (other.user_id === row.user_id) {
          throw new HttpError(422, 'invalid_swap', 'Both shifts are one person’s');
        }
        // Both go first, so neither person is blocked by the shift they are giving up.
        await cancel(request, row);
        await cancel(request, other);
        return {
          created: [
            await schedule(request, row, other.user_id),
            await schedule(request, other, row.user_id),
          ],
        };
      } catch (error) {
        throw refusal(error) ?? error;
      }
    },
  );
};
