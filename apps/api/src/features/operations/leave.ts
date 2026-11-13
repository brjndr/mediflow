import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders, IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import {
  LEAVE_KINDS,
  LeaveBalance,
  LeaveBalanceQuery,
  LeaveParams,
  LeaveSettings,
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
  kind: RosterLeave['kind'];
  days: number;
  self_approved: boolean;
  status: RosterLeave['status'];
  decided_by_name: string | null;
  decided_at: Date | null;
  version: number;
}

const SELECT = `select x.id, x.tenant_id, x.user_id, u.name as user_name, x.starts_at, x.ends_at,
       x.kind, x.self_approved, greatest(1, round(date_part('epoch', x.ends_at - x.starts_at) / 86400))::int as days,
       x.status, d.name as decided_by_name, x.decided_at, x.version
  from roster_leaves x
  join users u on u.id = x.user_id
  left join users d on d.id = x.decided_by`;

const YEAR_OF = `extract(year from x.starts_at at time zone
  (select timezone from tenants where id = app_tenant_id()))::int`;
const DAYS_OF = 'greatest(1, round(extract(epoch from x.ends_at - x.starts_at) / 86400))::int';

type Client = FastifyRequest['txClient'];

const settingsOf = async (client: Client): Promise<LeaveSettings> => {
  const settings = await client.query<{ self_approval: LeaveSettings['selfApproval'] }>(
    'select self_approval from roster_settings',
  );
  const allowances = await client.query<{
    kind: LeaveSettings['allowances'][number]['kind'];
    days: number;
  }>('select kind, days from roster_leave_allowances order by kind');
  return {
    selfApproval: settings.rows[0]?.self_approval ?? 'never',
    allowances: allowances.rows.map((row) => ({ kind: row.kind, days: row.days })),
  };
};

/** Whether anyone but this person could decide: an active member whose role holds roster:manage. */
const anotherManager = async (client: Client, userId: string): Promise<boolean> => {
  const { rows } = await client.query(
    `select 1 from memberships m
       join role_permissions rp on rp.tenant_id = m.tenant_id and rp.role_id = m.role_id
      where m.status = 'active' and m.user_id <> $1 and rp.permission = 'roster:manage' limit 1`,
    [userId],
  );
  return rows.length > 0;
};

/** Days of a person's requested and approved leave, by kind, for leaves starting in the year. */
const daysTaken = async (client: Client, userId: string, year: number) => {
  const { rows } = await client.query<{ kind: string; status: string; days: string }>(
    `select x.kind, x.status, sum(${DAYS_OF}) as days from roster_leaves x
      where x.user_id = $1 and x.status in ('requested', 'approved') and ${YEAR_OF} = $2
      group by x.kind, x.status`,
    [userId, year],
  );
  const taken = new Map<string, { used: number; pending: number }>();
  for (const row of rows) {
    const entry = taken.get(row.kind) ?? { used: 0, pending: 0 };
    if (row.status === 'approved') entry.used = Number(row.days);
    else entry.pending = Number(row.days);
    taken.set(row.kind, entry);
  }
  return taken;
};

const view = (row: LeaveRow): RosterLeave => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  userName: row.user_name,
  startsAt: iso(row.starts_at),
  endsAt: iso(row.ends_at),
  kind: row.kind,
  days: row.days,
  status: row.status,
  selfApproved: row.self_approved,
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
    selfApproved = false,
  ) => {
    try {
      await request.txClient.query(
        `update roster_leaves set status = $2,
                decided_by = case when $3::boolean then $4::uuid else decided_by end,
                decided_at = case when $3::boolean then now() else decided_at end,
                self_approved = $5::boolean
          where id = $1`,
        [row.id, status, decided, userIdOf(request), selfApproved],
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
    await request.emit(`roster.leave_${status}`, row.id, {
      userId: row.user_id,
      ...(selfApproved ? { selfApproved } : {}),
    });
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

  app.get(
    '/roster/leave-settings',
    {
      config: { permissions: ['roster:read'], feature: FEATURE },
      schema: {
        operationId: 'getLeaveSettings',
        tags: ['roster'],
        description:
          "The hospital's leave rules: the yearly allowance for each kind (a kind not listed has no limit) and whether the only manager may approve their own leave. Requires roster:read.",
        response: { 200: ref(LeaveSettings), ...errors(401, 403, 429) },
      },
    },
    async (request) => settingsOf(request.txClient),
  );

  app.put(
    '/roster/leave-settings',
    {
      config: {
        permissions: ['roster:manage'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'setLeaveSettings',
        tags: ['roster'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Replaces the leave rules. Each kind may appear once (422 `invalid_allowances`). Leaves already asked are not looked at again. The Idempotency-Key header is required. Audited. Requires roster:manage.',
        body: ref(LeaveSettings),
        response: { 200: ref(LeaveSettings), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      if (request.replayOf !== null) return settingsOf(request.txClient);
      const body = request.body as LeaveSettings;
      if (new Set(body.allowances.map((one) => one.kind)).size !== body.allowances.length) {
        throw new HttpError(422, 'invalid_allowances', 'A kind of leave is listed once');
      }
      const userId = userIdOf(request);
      await request.txClient.query(
        `insert into roster_settings (tenant_id, self_approval, updated_by)
         values (app_tenant_id(), $1, $2)
         on conflict (tenant_id) do update set self_approval = excluded.self_approval,
           updated_by = excluded.updated_by, updated_at = now()`,
        [body.selfApproval, userId],
      );
      await request.txClient.query('delete from roster_leave_allowances');
      for (const one of body.allowances) {
        await request.txClient.query(
          'insert into roster_leave_allowances (kind, days, updated_by) values ($1, $2, $3)',
          [one.kind, one.days, userId],
        );
      }
      request.audit('update', 'roster_settings');
      return settingsOf(request.txClient);
    },
  );

  app.get(
    '/roster/leave-balance',
    {
      config: { permissions: ['roster:read'], feature: FEATURE },
      schema: {
        operationId: 'getLeaveBalance',
        tags: ['roster'],
        description:
          "Days taken and waiting for each kind of leave in a calendar year on the hospital's clock (this year when `year` is left out), counted for leaves that start in it. Your own, or another person's with roster:manage (403 `permission_denied`). Requires roster:read.",
        querystring: LeaveBalanceQuery,
        response: { 200: ref(LeaveBalance), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const me = userIdOf(request);
      const userId = request.query.userId ?? me;
      if (userId !== me) await requireGrant(request, 'roster:manage');
      if (!isUuid(userId)) throw new HttpError(404, 'leave_not_found', 'No such person');
      const year =
        request.query.year ??
        (
          await request.txClient.query<{ year: number }>(
            `select extract(year from now() at time zone timezone)::int as year
               from tenants where id = app_tenant_id()`,
          )
        ).rows[0]?.year ??
        new Date().getUTCFullYear();
      const settings = await settingsOf(request.txClient);
      const taken = await daysTaken(request.txClient, userId, year);
      const items = LEAVE_KINDS.map((kind) => {
        const allowance = settings.allowances.find((one) => one.kind === kind)?.days;
        const used = taken.get(kind)?.used ?? 0;
        const pending = taken.get(kind)?.pending ?? 0;
        return {
          kind,
          ...(allowance === undefined
            ? {}
            : { allowanceDays: allowance, remainingDays: allowance - used - pending }),
          usedDays: used,
          pendingDays: pending,
        };
      });
      return { userId, year, items };
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
      const kind = (request.body.kind ?? 'annual') as RosterLeave['kind'];
      await request.txClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `leave-allowance:${userId}`,
      ]);
      const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY));
      const { rows: limits } = await request.txClient.query<{ days: number; year: number }>(
        `select a.days, extract(year from $2::timestamptz at time zone t.timezone)::int as year
           from roster_leave_allowances a join tenants t on t.id = a.tenant_id
          where a.kind = $1`,
        [kind, start],
      );
      const limit = limits[0];
      if (limit) {
        const taken = (await daysTaken(request.txClient, userId, limit.year)).get(kind);
        if ((taken?.used ?? 0) + (taken?.pending ?? 0) + days > limit.days) {
          throw new HttpError(
            422,
            'allowance_exceeded',
            'That is more days than the year allows for this kind of leave',
          );
        }
      }
      let id: string;
      try {
        const { rows } = await request.txClient.query<{ id: string }>(
          `insert into roster_leaves (user_id, starts_at, ends_at, kind, created_by)
           values ($1, $2, $3, $4, $1) returning id`,
          [userId, start, end, kind],
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
        kind,
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
        const own = row.user_id === userIdOf(request);
        if (own && verb === 'reject') {
          throw new HttpError(403, 'own_request', 'A second person decides on your leave');
        }
        if (row.status !== 'requested') {
          throw new HttpError(409, 'invalid_transition', 'The leave is not waiting for a decision');
        }
        if (own) {
          // Only where the hospital allows it, and only when nobody else could decide.
          const policy = (await settingsOf(request.txClient)).selfApproval;
          if (policy !== 'sole_manager' || (await anotherManager(request.txClient, row.user_id))) {
            throw new HttpError(403, 'own_request', 'A second person decides on your leave');
          }
        }
        return move(request, row, status, true, own);
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
