import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentPolicy, currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDepartment } from './departments';
import { mockStaffOf } from './staff';

type Shift = components['schemas']['RosterShift'];
type Create = components['schemas']['RosterShiftCreate'];
type Leave = components['schemas']['RosterLeave'];

const FEATURE_FLAG = 'roster';
const HOUR = 3_600_000;

interface StoredShift extends Shift {
  tenantId: string;
}
type Template = components['schemas']['ShiftTemplate'];
interface State {
  templates: Template[];
  shifts: StoredShift[];
  leaves: Leave[];
  created: number;
  replies: Map<string, string>;
}

const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR).toISOString();

/**
 * Built on first use, once the mock staff exist. The hospital: two people on a morning shift
 * today, one on call across the present moment, one person with two shifts only four hours
 * apart (a rest conflict) and one cancelled shift. The clinic: one shift, so lists differ.
 */
function seed(): State {
  const shifts: StoredShift[] = [];
  const add = (
    tenantId: string,
    index: number,
    shiftKind: Shift['shiftKind'],
    startsAt: string,
    endsAt: string,
    departmentId?: string,
    status: Shift['status'] = 'scheduled',
  ) => {
    const person = mockStaffOf(tenantId)[index];
    if (!person) return;
    const department = departmentId ? mockDepartment(tenantId, departmentId) : undefined;
    shifts.push({
      id: `shift_${shifts.length + 1}`,
      tenantId,
      userId: person.userId,
      userName: person.name,
      ...(department ? { departmentId: department.id, departmentName: department.name } : {}),
      shiftKind,
      startsAt,
      endsAt,
      status,
      version: 1,
    });
  };
  const H = TENANT_IDS.hospital;
  add(H, 0, 'morning', at(-2), at(6), 'dep_h_01');
  add(H, 1, 'morning', at(-2), at(6), 'dep_h_02');
  add(H, 2, 'on_call', at(-4), at(8), 'dep_h_01');
  add(H, 3, 'morning', at(-24), at(-16), 'dep_h_01');
  add(H, 3, 'evening', at(-12), at(-4), 'dep_h_01');
  add(H, 4, 'day', at(2), at(14), 'dep_h_02', 'cancelled');
  add(TENANT_IDS.clinic, 0, 'day', at(-1), at(11));
  const leaves: Leave[] = [];
  const ask = (index: number, from: number, to: number, status: Leave['status']) => {
    const person = mockStaffOf(H)[index];
    if (!person) return;
    leaves.push({
      id: `leave_${leaves.length + 1}`,
      tenantId: H,
      userId: person.userId,
      userName: person.name,
      startsAt: at(from),
      endsAt: at(to),
      status,
      ...(status === 'approved' ? { decidedByName: 'Admin', decidedAt: at(-5) } : {}),
      version: status === 'requested' ? 1 : 2,
    });
  };
  ask(3, 72, 120, 'requested');
  ask(4, -10, 272, 'approved');
  const templates: Template[] = [
    {
      id: 'tpl_1',
      tenantId: H,
      name: 'Early ward round',
      shiftKind: 'morning',
      startTime: '06:30',
      endTime: '14:30',
      active: true,
      version: 1,
    },
  ];
  return { templates, shifts, leaves, created: 0, replies: new Map() };
}

let state: State | undefined;
onMockReset(() => {
  state = undefined;
});
const current = () => (state ??= seed());

const ISO = /^\d{4}-\d{2}-\d{2}T/;

export const rosterHandlers = [
  http.get('*/api/roster/shifts', ({ request }) => {
    const access = authorize(request, { permission: 'roster:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const from = query.get('from');
    const to = query.get('to');
    const departmentId = query.get('departmentId');
    const userId = query.get('userId');
    const includeCancelled = query.get('includeCancelled') === 'true';
    const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100);
    // Tenant isolation: only shifts of the session's hospital are ever considered.
    const rows = current()
      .shifts.filter(
        (one) =>
          one.tenantId === access.tenantId &&
          (includeCancelled || one.status === 'scheduled') &&
          (!from || one.endsAt > from) &&
          (!to || one.startsAt < to) &&
          (!departmentId || one.departmentId === departmentId) &&
          (!userId || one.userId === userId),
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    const cursor = query.get('cursor');
    const start = cursor ? rows.findIndex((one) => one.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      items: rows.slice(start, start + limit),
      nextCursor: rows[start + limit]?.id ?? null,
    });
  }),

  http.post('*/api/roster/shifts', async ({ request }) => {
    const access = authorize(request, { permission: 'roster:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const body = (await request.json()) as Create;
    const replyKey = `${access.tenantId}:${key}`;
    const known = current().replies.get(replyKey);
    if (known) {
      const found = current().shifts.find((one) => one.id === known);
      if (found) return HttpResponse.json(found, { status: 201 });
    }
    const start = Date.parse(body.startsAt);
    const end = Date.parse(body.endsAt);
    if (!ISO.test(body.startsAt) || !(end > start) || end - start > 24 * HOUR) {
      return error(422, 'invalid_period', 'A shift ends after it starts, within a day');
    }
    const person = mockStaffOf(access.tenantId).find((one) => one.userId === body.userId);
    if (!person) return error(422, 'unknown_user', 'No such member');
    const department = body.departmentId
      ? mockDepartment(access.tenantId, body.departmentId)
      : undefined;
    if (body.departmentId && !department) {
      return error(422, 'unknown_department', 'No such department');
    }
    const clash = current().shifts.some(
      (one) =>
        one.tenantId === access.tenantId &&
        one.userId === body.userId &&
        one.status === 'scheduled' &&
        Date.parse(one.startsAt) < end &&
        Date.parse(one.endsAt) > start,
    );
    if (clash) return error(409, 'shift_overlap', 'The person is already on duty then');
    const away = current().leaves.some(
      (one) =>
        one.tenantId === access.tenantId &&
        one.userId === body.userId &&
        one.status === 'approved' &&
        Date.parse(one.startsAt) < end &&
        Date.parse(one.endsAt) > start,
    );
    if (away) return error(409, 'on_leave', 'The person is on approved leave then');
    const s = current();
    s.created += 1;
    const made: StoredShift = {
      id: `shift_new_${s.created}`,
      tenantId: access.tenantId,
      userId: person.userId,
      userName: person.name,
      ...(department ? { departmentId: department.id, departmentName: department.name } : {}),
      shiftKind: body.shiftKind,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      status: 'scheduled',
      version: 1,
    };
    s.shifts.push(made);
    s.replies.set(replyKey, made.id);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.post('*/api/roster/shifts/:shiftId/cancel', async ({ request, params }) => {
    const access = authorize(request, { permission: 'roster:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json()) as { version: number };
    const found = current().shifts.find(
      (one) => one.id === params.shiftId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'shift_not_found', 'No such shift');
    if (found.version !== body.version) {
      return error(409, 'conflict', 'The shift has changed since it was read');
    }
    if (found.status !== 'scheduled') {
      return error(409, 'invalid_transition', 'The shift is already cancelled');
    }
    found.status = 'cancelled';
    found.version += 1;
    return HttpResponse.json(found);
  }),
  http.get('*/api/roster/templates', ({ request }) => {
    const access = authorize(request, { permission: 'roster:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const all = new URL(request.url).searchParams.get('includeInactive') === 'true';
    const items = current().templates.filter(
      (one) => one.tenantId === access.tenantId && (all || one.active),
    );
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post('*/api/roster/templates', async ({ request }) => {
    const access = authorize(request, { permission: 'roster:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body = (await request.json()) as components['schemas']['ShiftTemplateCreate'];
    if (body.startTime === body.endTime) return error(422, 'invalid_period', 'A shift has hours');
    const department = body.departmentId
      ? mockDepartment(access.tenantId, body.departmentId)
      : undefined;
    if (body.departmentId && !department) {
      return error(422, 'unknown_department', 'No such department');
    }
    const s = current();
    if (
      s.templates.some(
        (one) =>
          one.tenantId === access.tenantId &&
          one.active &&
          one.name.toLowerCase() === body.name.trim().toLowerCase(),
      )
    ) {
      return error(409, 'template_exists', 'A template has that name');
    }
    s.created += 1;
    const made: Template = {
      id: `tpl_new_${s.created}`,
      tenantId: access.tenantId,
      name: body.name.trim(),
      shiftKind: body.shiftKind,
      startTime: body.startTime,
      endTime: body.endTime,
      ...(department ? { departmentId: department.id, departmentName: department.name } : {}),
      active: true,
      version: 1,
    };
    s.templates.push(made);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.post('*/api/roster/templates/:templateId/retire', async ({ request, params }) => {
    const access = authorize(request, { permission: 'roster:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json()) as { version: number };
    const found = current().templates.find(
      (one) => one.id === params.templateId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'template_not_found', 'No such template');
    if (found.version !== body.version) return error(409, 'conflict', 'The template has changed');
    if (!found.active) return error(409, 'invalid_transition', 'The template is already retired');
    found.active = false;
    found.version += 1;
    return HttpResponse.json(found);
  }),

  http.post('*/api/roster/copy-week', async ({ request }) => {
    const access = authorize(request, { permission: 'roster:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body = (await request.json()) as components['schemas']['CopyWeekBody'];
    const from = Date.parse(body.fromStart);
    const delta = Date.parse(body.toStart) - from;
    const weeks = body.weeks ?? 1;
    const week = 7 * 24 * HOUR;
    if (!Number.isFinite(delta) || delta % (24 * HOUR) !== 0 || Math.abs(delta) < week) {
      return error(422, 'invalid_period', 'The weeks are a whole number of days apart');
    }
    const s = current();
    const sources = s.shifts.filter(
      (one) =>
        one.tenantId === access.tenantId &&
        one.status === 'scheduled' &&
        Date.parse(one.startsAt) >= from &&
        Date.parse(one.startsAt) < from + week &&
        (!body.departmentId || one.departmentId === body.departmentId),
    );
    if (sources.length > 300 || sources.length * weeks > 1000) {
      return error(422, 'too_many_shifts', 'Too many shifts to copy at once');
    }
    let copied = 0;
    const skipped: components['schemas']['CopyWeekResult']['skipped'] = [];
    for (let k = 0; k < weeks; k += 1) {
      for (const source of sources) {
        const offset = delta + k * week;
        const start = Date.parse(source.startsAt) + offset;
        const end = Date.parse(source.endsAt) + offset;
        const busy = (list: { userId: string; startsAt: string; endsAt: string }[]) =>
          list.some(
            (one) =>
              one.userId === source.userId &&
              Date.parse(one.startsAt) < end &&
              Date.parse(one.endsAt) > start,
          );
        const reason = busy(
          s.leaves.filter((one) => one.tenantId === access.tenantId && one.status === 'approved'),
        )
          ? 'on_leave'
          : busy(
                s.shifts.filter(
                  (one) => one.tenantId === access.tenantId && one.status === 'scheduled',
                ),
              )
            ? 'shift_overlap'
            : undefined;
        if (reason) {
          skipped.push({
            shiftId: source.id,
            userName: source.userName,
            startsAt: new Date(start).toISOString(),
            reason,
          });
          continue;
        }
        s.created += 1;
        s.shifts.push({
          ...source,
          id: `shift_new_${s.created}`,
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(end).toISOString(),
          version: 1,
        });
        copied += 1;
      }
    }
    return HttpResponse.json({ copied, skipped });
  }),

  http.post('*/api/roster/shifts/:shiftId/swap', async ({ request, params }) => {
    const access = authorize(request, { permission: 'roster:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body = (await request.json()) as components['schemas']['ShiftSwapBody'];
    const s = current();
    const own = (id: string | undefined) =>
      s.shifts.find((one) => one.id === id && one.tenantId === access.tenantId);
    const found = own(params.shiftId as string);
    if (!found) return error(404, 'shift_not_found', 'No such shift');
    if (found.version !== body.version) return error(409, 'conflict', 'The shift has changed');
    if (found.status !== 'scheduled') return error(409, 'invalid_transition', 'Cancelled');
    if ((body.userId === undefined) === (body.withShiftId === undefined)) {
      return error(422, 'invalid_swap', 'Name a person, or a shift to exchange with');
    }
    const other = body.withShiftId === undefined ? undefined : own(body.withShiftId);
    if (body.withShiftId !== undefined) {
      if (!other || other.id === found.id) return error(404, 'shift_not_found', 'No such shift');
      if (other.version !== body.withVersion) return error(409, 'conflict', 'Shift changed');
      if (other.status !== 'scheduled') return error(409, 'invalid_transition', 'Cancelled');
      if (other.userId === found.userId) return error(422, 'invalid_swap', 'One person');
    }
    const person = mockStaffOf(access.tenantId).find(
      (one) => one.userId === (other ? other.userId : body.userId),
    );
    if (!person) return error(422, 'unknown_user', 'No such member');
    if (!other && person.userId === found.userId) {
      return error(422, 'invalid_swap', 'The shift is already theirs');
    }
    const pairs: [StoredShift, { userId: string; userName: string }][] = other
      ? [
          [found, other],
          [other, { userId: found.userId, userName: found.userName }],
        ]
      : [[found, { userId: person.userId, userName: person.name }]];
    const leaving = new Set(other ? [found.id, other.id] : [found.id]);
    for (const [source, to] of pairs) {
      const start = Date.parse(source.startsAt);
      const end = Date.parse(source.endsAt);
      const clash = s.shifts.some(
        (one) =>
          one.tenantId === access.tenantId &&
          one.userId === to.userId &&
          one.status === 'scheduled' &&
          !leaving.has(one.id) &&
          Date.parse(one.startsAt) < end &&
          Date.parse(one.endsAt) > start,
      );
      if (clash) return error(409, 'shift_overlap', 'The person is already on duty then');
      const away = s.leaves.some(
        (one) =>
          one.tenantId === access.tenantId &&
          one.userId === to.userId &&
          one.status === 'approved' &&
          Date.parse(one.startsAt) < end &&
          Date.parse(one.endsAt) > start,
      );
      if (away) return error(409, 'on_leave', 'The person is on approved leave then');
    }
    const created: StoredShift[] = [];
    for (const [source, to] of pairs) {
      source.status = 'cancelled';
      source.version += 1;
      s.created += 1;
      const made: StoredShift = {
        ...source,
        id: `shift_new_${s.created}`,
        userId: to.userId,
        userName: to.userName,
        status: 'scheduled',
        version: 1,
      };
      created.push(made);
    }
    s.shifts.push(...created);
    return HttpResponse.json({ created });
  }),

  http.get('*/api/roster/leaves', ({ request }) => {
    const access = authorize(request, { permission: 'roster:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const from = query.get('from');
    const to = query.get('to');
    const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100);
    const rows = current()
      .leaves.filter(
        (one) =>
          one.tenantId === access.tenantId &&
          (!from || one.endsAt > from) &&
          (!to || one.startsAt < to) &&
          (!query.get('status') || one.status === query.get('status')),
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    const cursor = query.get('cursor');
    const start = cursor ? rows.findIndex((one) => one.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      items: rows.slice(start, start + limit),
      nextCursor: rows[start + limit]?.id ?? null,
    });
  }),

  http.post('*/api/roster/leaves', async ({ request }) => {
    const access = authorize(request, {
      permission: 'roster:requestLeave',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body = (await request.json()) as { startsAt: string; endsAt: string };
    const start = Date.parse(body.startsAt);
    const end = Date.parse(body.endsAt);
    if (!(end > start) || end - start > 90 * 24 * HOUR || end <= Date.now()) {
      return error(422, 'invalid_period', 'A leave ends after it starts, within 90 days');
    }
    const user = currentSession()?.user;
    if (!user) return error(401, 'unauthenticated', 'No session');
    const clash = current().leaves.some(
      (one) =>
        one.tenantId === access.tenantId &&
        one.userId === user.id &&
        (one.status === 'requested' || one.status === 'approved') &&
        Date.parse(one.startsAt) < end &&
        Date.parse(one.endsAt) > start,
    );
    if (clash) return error(409, 'leave_overlap', 'You already have a leave then');
    const s = current();
    s.created += 1;
    const made: Leave = {
      id: `leave_new_${s.created}`,
      tenantId: access.tenantId,
      userId: user.id,
      userName: user.name,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      status: 'requested',
      version: 1,
    };
    s.leaves.push(made);
    return HttpResponse.json(made, { status: 201 });
  }),

  ...(['approve', 'reject', 'cancel'] as const).map((verb) =>
    http.post(`*/api/roster/leaves/:leaveId/${verb}`, async ({ request, params }) => {
      const access = authorize(request, {
        permission: verb === 'cancel' ? 'roster:read' : 'roster:manage',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in access) return access.denied;
      const body = (await request.json()) as { version: number };
      const found = current().leaves.find(
        (one) => one.id === params.leaveId && one.tenantId === access.tenantId,
      );
      if (!found) return error(404, 'leave_not_found', 'No such leave');
      if (found.version !== body.version) {
        return error(409, 'conflict', 'The leave has changed since it was read');
      }
      const user = currentSession()?.user;
      const own = found.userId === user?.id;
      if (verb === 'cancel') {
        const needed = own ? 'roster:requestLeave' : 'roster:manage';
        if (!currentPolicy()?.permissions.some((grant) => grant.permission === needed)) {
          return error(403, 'permission_denied', `Missing ${needed}`);
        }
        if (found.status !== 'requested' && found.status !== 'approved') {
          return error(409, 'invalid_transition', 'The leave is already decided or withdrawn');
        }
        found.status = 'cancelled';
      } else {
        if (own) return error(403, 'own_request', 'A second person decides on your leave');
        if (found.status !== 'requested') {
          return error(409, 'invalid_transition', 'The leave is not waiting for a decision');
        }
        if (verb === 'approve') {
          const shifts = current().shifts.some(
            (one) =>
              one.tenantId === access.tenantId &&
              one.userId === found.userId &&
              one.status === 'scheduled' &&
              one.startsAt < found.endsAt &&
              one.endsAt > found.startsAt,
          );
          if (shifts) {
            return error(409, 'shifts_in_leave', 'The person still has shifts in that time');
          }
        }
        found.status = verb === 'approve' ? 'approved' : 'rejected';
        found.decidedByName = user?.name ?? '';
        found.decidedAt = new Date().toISOString();
      }
      found.version += 1;
      return HttpResponse.json(found);
    }),
  ),
];
