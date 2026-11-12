import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders, IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import {
  LeaveParams,
  RosterLeave,
  RosterLeaveCreate,
  RosterLeaveListQuery,
  RosterLeavePage,
  VersionBody,
} from './schemas.js';
import { isCode, iso, requireGrant, userIdOf, uuidOr404 } from './util.js';

const FEATURE = 'roster';
const DAY = 24 * 3_600_000;

interface LeaveRow {
  id: string;
  tenant_id: string;
  user_id: string;
  user_name: string;
  starts_at: Date;
  ends_at: Date;
  status: RosterLeave['status'];
  decided_by_name: string | null;
  decided_at: Date | null;
  version: number;
}

const SELECT = `select x.id, x.tenant_id, x.user_id, u.name as user_name, x.starts_at, x.ends_at,
       x.status, d.name as decided_by_name, x.decided_at, x.version
  from roster_leaves x
  join users u on u.id = x.user_id
  left join users d on d.id = x.decided_by`;

const view = (row: LeaveRow): RosterLeave => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  userName: row.user_name,
  startsAt: iso(row.starts_at),
  endsAt: iso(row.ends_at),
  status: row.status,
  ...(row.decided_by_name === null ? {} : { decidedByName: row.decided_by_name }),
  ...(row.decided_at === null ? {} : { decidedAt: iso(row.decided_at) }),
  version: row.version,
});

/**
 * Leave requests for the duty roster (#591): a member of staff asks for time off, a second person
 * with `roster:manage` approves or rejects it, and an approved leave keeps the person off the
 * roster (the database refuses a shift into it, and the approval while shifts overlap it).
 */
export const leaveRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const find = async (request: FastifyRequest, id: string) => {
    const { rows } = await request.txClient.query<LeaveRow>(`${SELECT} where x.id = $1`, [id]);
    return rows[0] ?? null;
  };

  const load = async (request: FastifyRequest, rawId: string, version: number) => {
    const id = uuidOr404(rawId, 'leave_not_found', 'No such leave');
    const row = await find(request, id);
    if (!row) throw new HttpError(404, 'leave_not_found', 'No such leave');
    if (row.version !== version) {
      throw new HttpError(409, 'conflict', 'The leave has changed since it was read');
    }
    return row;
  };

  const move = async (
    request: FastifyRequest,
    row: LeaveRow,
    status: RosterLeave['status'],
    decided: boolean,
  ) => {
    try {
      await request.txClient.query(
        `update roster_leaves set status = $2,
                decided_by = case when $3::boolean then $4::uuid else decided_by end,
                decided_at = case when $3::boolean then now() else decided_at end
          where id = $1`,
        [row.id, status, decided, userIdOf(request)],
      );
    } catch (error) {
      if (isCode(error, '23P01', 'roster_leave_has_shifts')) {
        throw new HttpError(
          409,
          'shifts_in_leave',
          'The person still has shifts in that time; cancel them first',
        );
      }
      throw error;
    }
    request.audit('update', 'roster_leave', row.id);
    await request.emit(`roster.leave_${status}`, row.id, { userId: row.user_id });
    return view((await find(request, row.id)) as LeaveRow);
  };

  app.get(
    '/roster/leaves',
    {
      config: { permissions: ['roster:read'], feature: FEATURE },
      schema: {
        operationId: 'listRosterLeaves',
        tags: ['roster'],
        description:
          'Leave requests by start time, oldest first. `from` and `to` keep the leaves that overlap that window. Requires roster:read.',
        querystring: RosterLeaveListQuery,
        response: { 200: ref(RosterLeavePage), ...errors(400, 401, 403, 429) },
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
      if (q.from) add('x.ends_at > ?::timestamptz', q.from);
      if (q.to) add('x.starts_at < ?::timestamptz', q.to);
      if (q.userId) add('x.user_id::text = ?', q.userId);
      if (q.status) add('x.status = ?', q.status);
      const page = await selectPage<LeaveRow>(request.txClient, {
        select: SELECT,
        where,
        params,
        order: 'x.starts_at',
        cursor: q.cursor,
        limit: q.limit ?? DEFAULT_PAGE_SIZE,
      });
      return { items: page.rows.map(view), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/roster/leaves',
    {
      config: {
        permissions: ['roster:requestLeave'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'requestRosterLeave',
        tags: ['roster'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Asks for leave for the caller, for a period that ends in the future, at most 90 days (422 `invalid_period`). It may not overlap another requested or approved leave of the caller (409 `leave_overlap`). The Idempotency-Key header is required. Audited; emits `roster.leave_requested`. Requires roster:requestLeave.',
        body: RosterLeaveCreate,
        response: { 201: ref(RosterLeave), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const start = new Date(request.body.startsAt);
      const end = new Date(request.body.endsAt);
      if (!(end > start) || end.getTime() - start.getTime() > 90 * DAY || end <= new Date()) {
        throw new HttpError(422, 'invalid_period', 'A leave ends after it starts, within 90 days');
      }
      const userId = userIdOf(request);
      let id: string;
      try {
        const { rows } = await request.txClient.query<{ id: string }>(
          `insert into roster_leaves (user_id, starts_at, ends_at, created_by)
           values ($1, $2, $3, $1) returning id`,
          [userId, start, end],
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        if (isCode(error, '23P01')) {
          throw new HttpError(409, 'leave_overlap', 'You already have a leave then');
        }
        throw error;
      }
      request.audit('create', 'roster_leave', id);
      await request.emit('roster.leave_requested', id, {
        userId,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      });
      return reply.status(201).send(view((await find(request, id)) as LeaveRow));
    },
  );

  for (const [verb, status] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post(
      `/roster/leaves/:leaveId/${verb}`,
      {
        config: { permissions: ['roster:manage'], feature: FEATURE, idempotent: { body: 'full' } },
        schema: {
          operationId: `${verb}RosterLeave`,
          tags: ['roster'],
          headers: IdempotencyHeaders,
          description:
            verb === 'approve'
              ? 'Approves a requested leave, by someone other than its owner (403 `own_request`). The `version` is the leave version, or 409 `conflict`; a leave not requested is 409 `invalid_transition`. While the person has scheduled shifts in the period it is 409 `shifts_in_leave`: cancel them first. Audited; emits `roster.leave_approved`. Requires roster:manage.'
              : 'Rejects a requested leave, by someone other than its owner (403 `own_request`). The `version` is the leave version, or 409 `conflict`; a leave not requested is 409 `invalid_transition`. Audited; emits `roster.leave_rejected`. Requires roster:manage.',
          params: LeaveParams,
          body: VersionBody,
          response: { 200: ref(RosterLeave), ...errors(400, 401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const row = await load(request, request.params.leaveId, request.body.version);
        if (row.user_id === userIdOf(request)) {
          throw new HttpError(403, 'own_request', 'A second person decides on your leave');
        }
        if (row.status !== 'requested') {
          throw new HttpError(409, 'invalid_transition', 'The leave is not waiting for a decision');
        }
        return move(request, row, status, true);
      },
    );
  }

  app.post(
    '/roster/leaves/:leaveId/cancel',
    {
      config: { permissions: ['roster:read'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'cancelRosterLeave',
        tags: ['roster'],
        headers: IdempotencyHeaders,
        description:
          'Withdraws a requested or approved leave: its owner with roster:requestLeave, or anyone with roster:manage (403 `permission_denied` otherwise). The `version` is the leave version, or 409 `conflict`; a leave already rejected or cancelled is 409 `invalid_transition`. Audited; emits `roster.leave_cancelled`. Requires roster:read.',
        params: LeaveParams,
        body: VersionBody,
        response: { 200: ref(RosterLeave), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const raw = request.params.leaveId;
      if (!isUuid(raw)) throw new HttpError(404, 'leave_not_found', 'No such leave');
      const row = await load(request, raw, request.body.version);
      const own = row.user_id === userIdOf(request);
      await requireGrant(request, own ? 'roster:requestLeave' : 'roster:manage');
      if (row.status !== 'requested' && row.status !== 'approved') {
        throw new HttpError(409, 'invalid_transition', 'The leave is already decided or withdrawn');
      }
      return move(request, row, 'cancelled', false);
    },
  );
};
