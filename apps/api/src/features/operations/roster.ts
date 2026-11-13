import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders, IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import {
  RosterShift,
  RosterShiftCreate,
  RosterShiftListQuery,
  RosterShiftPage,
  ShiftParams,
  VersionBody,
} from './schemas.js';
import { isCode, iso, userIdOf, uuidOr404 } from './util.js';

const FEATURE = 'roster';

export interface ShiftRow {
  id: string;
  tenant_id: string;
  user_id: string;
  user_name: string;
  department_id: string | null;
  department_name: string | null;
  shift_kind: RosterShift['shiftKind'];
  starts_at: Date;
  ends_at: Date;
  status: RosterShift['status'];
  version: number;
}

export const SHIFT_SELECT = `select x.id, x.tenant_id, x.user_id, u.name as user_name, x.department_id,
       d.name as department_name, x.shift_kind, x.starts_at, x.ends_at, x.status, x.version
  from roster_shifts x
  join users u on u.id = x.user_id
  left join departments d on d.tenant_id = x.tenant_id and d.id = x.department_id`;

export const shiftView = (row: ShiftRow): RosterShift => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  userName: row.user_name,
  ...(row.department_id === null
    ? {}
    : { departmentId: row.department_id, departmentName: row.department_name ?? '' }),
  shiftKind: row.shift_kind,
  startsAt: iso(row.starts_at),
  endsAt: iso(row.ends_at),
  status: row.status,
  version: row.version,
});

export const rosterRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const find = async (request: { txClient: pg.ClientBase }, id: string) => {
    const { rows } = await request.txClient.query<ShiftRow>(`${SHIFT_SELECT} where x.id = $1`, [
      id,
    ]);
    return rows[0] ?? null;
  };

  app.get(
    '/roster/shifts',
    {
      config: { permissions: ['roster:read'], feature: FEATURE },
      schema: {
        operationId: 'listRosterShifts',
        tags: ['roster'],
        description:
          'Duty shifts by start time, oldest first, for the hospital. `from` and `to` keep the shifts that overlap that window; cancelled shifts are left out unless `includeCancelled`. Requires roster:read.',
        querystring: RosterShiftListQuery,
        response: { 200: ref(RosterShiftPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.includeCancelled !== true) where.push("x.status = 'scheduled'");
      if (q.from) add('x.ends_at > ?::timestamptz', q.from);
      if (q.to) add('x.starts_at < ?::timestamptz', q.to);
      if (q.userId) add('x.user_id::text = ?', q.userId);
      if (q.departmentId) add('x.department_id::text = ?', q.departmentId);
      const page = await selectPage<ShiftRow>(request.txClient, {
        select: SHIFT_SELECT,
        where,
        params,
        order: 'x.starts_at',
        cursor: q.cursor,
        limit: q.limit ?? DEFAULT_PAGE_SIZE,
      });
      return { items: page.rows.map(shiftView), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/roster/shifts',
    {
      config: {
        permissions: ['roster:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createRosterShift',
        tags: ['roster'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Puts a member of the hospital on duty. The end is after the start and at most 24 hours later (422 `invalid_period`). A person is on one shift at a time: an overlap with another scheduled shift is 409 `shift_overlap`, whatever the department. 409 `on_leave` while the person has an approved leave then. 422 `unknown_user` for someone who is not a member here, 422 `unknown_department`. The Idempotency-Key header is required. Audited; emits `roster.shift_scheduled`. Requires roster:manage.',
        body: RosterShiftCreate,
        response: { 201: ref(RosterShift), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const start = new Date(body.startsAt);
      const end = new Date(body.endsAt);
      if (!(end > start) || end.getTime() - start.getTime() > 24 * 3_600_000) {
        throw new HttpError(422, 'invalid_period', 'A shift ends after it starts, within a day');
      }
      if (!isUuid(body.userId)) throw new HttpError(422, 'unknown_user', 'No such member');
      if (body.departmentId !== undefined && !isUuid(body.departmentId)) {
        throw new HttpError(422, 'unknown_department', 'No such department');
      }
      const client = request.txClient;
      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into roster_shifts (user_id, department_id, shift_kind, starts_at, ends_at, created_by)
           values ($1, $2, $3, $4, $5, $6)
           returning id`,
          [body.userId, body.departmentId ?? null, body.shiftKind, start, end, userIdOf(request)],
        );
        const created = rows[0];
        if (!created) throw new HttpError(422, 'unknown_user', 'No such member');
        id = created.id;
      } catch (error) {
        if (isCode(error, '23P01', 'roster_shift_on_leave')) {
          throw new HttpError(409, 'on_leave', 'The person is on approved leave then');
        }
        if (isCode(error, '23P01')) {
          throw new HttpError(409, 'shift_overlap', 'The person is already on duty then');
        }
        if (isCode(error, '23503', 'roster_shifts_member')) {
          throw new HttpError(422, 'unknown_user', 'No such member');
        }
        if (isCode(error, '23503', 'roster_shifts_department')) {
          throw new HttpError(422, 'unknown_department', 'No such department');
        }
        throw error;
      }
      request.audit('create', 'roster_shift', id);
      await request.emit('roster.shift_scheduled', id, {
        userId: body.userId,
        departmentId: body.departmentId ?? null,
        shiftKind: body.shiftKind,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      });
      const row = await find(request, id);
      return reply.status(201).send(shiftView(row as ShiftRow));
    },
  );

  app.post(
    '/roster/shifts/:shiftId/cancel',
    {
      config: {
        permissions: ['roster:manage'],
        feature: FEATURE,
        idempotent: { body: 'full' },
      },
      schema: {
        operationId: 'cancelRosterShift',
        tags: ['roster'],
        headers: IdempotencyHeaders,
        description:
          'Cancels a scheduled shift, once; the row stays as the record. The `version` is the shift’s, or 409 `conflict`; a shift already cancelled is 409 `invalid_transition`. Audited; emits `roster.shift_cancelled`. Requires roster:manage.',
        params: ShiftParams,
        body: VersionBody,
        response: { 200: ref(RosterShift), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.shiftId, 'shift_not_found', 'No such shift');
      const row = await find(request, id);
      if (!row) throw new HttpError(404, 'shift_not_found', 'No such shift');
      if (row.version !== request.body.version) {
        throw new HttpError(409, 'conflict', 'The shift has changed since it was read');
      }
      if (row.status !== 'scheduled') {
        throw new HttpError(409, 'invalid_transition', 'The shift is already cancelled');
      }
      await request.txClient.query("update roster_shifts set status = 'cancelled' where id = $1", [
        id,
      ]);
      request.audit('update', 'roster_shift', id);
      await request.emit('roster.shift_cancelled', id, { userId: row.user_id });
      return shiftView((await find(request, id)) as ShiftRow);
    },
  );
};
