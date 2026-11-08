import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDepartment } from './departments';
import { mockStaffOf } from './staff';

type Shift = components['schemas']['RosterShift'];
type Create = components['schemas']['RosterShiftCreate'];

const FEATURE_FLAG = 'roster';
const HOUR = 3_600_000;

interface StoredShift extends Shift {
  tenantId: string;
}
interface State {
  shifts: StoredShift[];
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
  return { shifts, created: 0, replies: new Map() };
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
];
