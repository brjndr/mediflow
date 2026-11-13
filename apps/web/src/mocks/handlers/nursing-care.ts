import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type WardFluid = components['schemas']['WardFluid'];
type CarePlan = components['schemas']['CarePlan'];
type Stored<T> = T & { key: string };

const FEATURE_FLAG = 'nursing';
const INTAKE = ['oral', 'intravenous', 'tube', 'other_intake'];

let fluids: Stored<WardFluid>[] = [];
let plans: Stored<CarePlan>[] = [];
let counter = 0;
onMockReset(() => {
  fluids = [];
  plans = [];
  counter = 0;
});

/** For tests: a fluid entry already on a stay. */
export function addMockWardFluid(entry: Partial<WardFluid> & { id: string; admissionId: string }) {
  fluids.push({
    tenantId: TENANT_IDS.hospital,
    direction: 'intake',
    kind: 'oral',
    amountMl: 200,
    observedAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    recordedById: 'user_nurse',
    recordedByName: 'Nurse Nandini',
    key: entry.id,
    ...entry,
  });
}

/** For tests: a care plan already on a stay. */
export function addMockCarePlan(plan: Partial<CarePlan> & { id: string; admissionId: string }) {
  plans.push({
    tenantId: TENANT_IDS.hospital,
    problem: 'Risk of falls',
    status: 'active',
    createdAt: new Date().toISOString(),
    createdById: 'user_nurse',
    createdByName: 'Nurse Nandini',
    tasks: [],
    key: plan.id,
    ...plan,
  });
}

const fluidView = ({ key: _key, ...entry }: Stored<WardFluid>): WardFluid => ({
  ...entry,
  ...(fluids.find((each) => each.correctsId === entry.id)
    ? { correctedById: fluids.find((each) => each.correctsId === entry.id)?.id }
    : {}),
});
const planView = ({ key: _key, ...plan }: Stored<CarePlan>): CarePlan => plan;

function pageOf<T>(request: Request, all: T[], idOf: (each: T) => string) {
  const query = new URL(request.url).searchParams;
  const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((each) => idOf(each) === cursor) : 0;
  if (start < 0) return null;
  const next = all[start + limit];
  return {
    items: all.slice(start, start + limit),
    nextCursor: next ? idOf(next) : null,
    ...(cursor ? {} : { total: all.length }),
  };
}

const within = (at: string, from: string | null, to: string | null) =>
  (from === null || at >= from) && (to === null || at < to);

function requireKey(request: Request) {
  const key = request.headers.get('idempotency-key');
  return key === null ? null : key;
}

export const careHandlers = [
  http.get('*/api/admissions/:admissionId/fluids/totals', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'fluidBalance:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const from = query.get('from');
    const to = query.get('to');
    if (!from || !to) return error(400, 'validation_failed', 'The request is not valid');
    const standing = fluids.filter(
      (each) =>
        each.tenantId === access.tenantId &&
        each.admissionId === params.admissionId &&
        within(each.observedAt, from, to) &&
        !fluids.some((other) => other.correctsId === each.id),
    );
    const sum = (direction: string) =>
      standing.filter((each) => each.direction === direction).reduce((n, e) => n + e.amountMl, 0);
    return HttpResponse.json({
      from,
      to,
      intakeMl: sum('intake'),
      outputMl: sum('output'),
      balanceMl: sum('intake') - sum('output'),
      entries: standing.length,
    });
  }),

  http.get('*/api/admissions/:admissionId/fluids', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'fluidBalance:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const own = fluids
      .filter(
        (each) =>
          each.tenantId === access.tenantId &&
          each.admissionId === params.admissionId &&
          within(each.observedAt, query.get('from'), query.get('to')),
      )
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    const page = pageOf(request, own, (each) => each.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({ ...page, items: page.items.map(fluidView) });
  }),

  http.post('*/api/admissions/:admissionId/fluids', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'fluidBalance:record',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = requireKey(request);
    if (key === null)
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const repeat = fluids.find((each) => each.key === key && each.tenantId === access.tenantId);
    if (repeat) return HttpResponse.json(fluidView(repeat), { status: 201 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.kind !== 'string' || typeof body.amountMl !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const user = currentSession()?.user;
    counter += 1;
    const now = new Date().toISOString();
    const entry: Stored<WardFluid> = {
      id: `fluid_${counter}`,
      tenantId: access.tenantId,
      admissionId: String(params.admissionId),
      direction: INTAKE.includes(body.kind) ? 'intake' : 'output',
      kind: body.kind as WardFluid['kind'],
      amountMl: body.amountMl,
      observedAt: typeof body.observedAt === 'string' ? body.observedAt : now,
      recordedAt: now,
      recordedById: user?.id ?? '',
      recordedByName: user?.name ?? '',
      key,
    };
    fluids.push(entry);
    return HttpResponse.json(fluidView(entry), { status: 201 });
  }),

  http.post(
    '*/api/admissions/:admissionId/fluids/:fluidId/correct',
    async ({ request, params }) => {
      const access = authorize(request, {
        permission: 'fluidBalance:record',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in access) return access.denied;
      const key = requireKey(request);
      if (key === null) {
        return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
      }
      const repeat = fluids.find((each) => each.key === key && each.tenantId === access.tenantId);
      if (repeat) return HttpResponse.json(fluidView(repeat), { status: 201 });
      const original = fluids.find(
        (each) =>
          each.id === params.fluidId &&
          each.tenantId === access.tenantId &&
          each.admissionId === params.admissionId,
      );
      if (!original) return error(404, 'fluid_not_found', 'No such entry');
      if (fluids.some((each) => each.correctsId === original.id)) {
        return error(422, 'already_corrected', 'The entry is already corrected');
      }
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.kind !== 'string' ||
        typeof body.amountMl !== 'number' ||
        typeof body.reason !== 'string' ||
        body.reason === ''
      ) {
        return error(400, 'validation_failed', 'The request is not valid');
      }
      const direction = INTAKE.includes(body.kind) ? 'intake' : 'output';
      if (direction !== original.direction) {
        return error(422, 'direction_changed', 'A correction keeps intake or output');
      }
      const user = currentSession()?.user;
      counter += 1;
      const entry: Stored<WardFluid> = {
        ...original,
        id: `fluid_${counter}`,
        kind: body.kind as WardFluid['kind'],
        amountMl: body.amountMl,
        recordedAt: new Date().toISOString(),
        recordedById: user?.id ?? '',
        recordedByName: user?.name ?? '',
        correctsId: original.id,
        correctionReason: body.reason,
        key,
      };
      fluids.push(entry);
      return HttpResponse.json(fluidView(entry), { status: 201 });
    },
  ),

  http.get('*/api/admissions/:admissionId/care-plans', ({ request, params }) => {
    const access = authorize(request, { permission: 'carePlan:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const own = plans
      .filter(
        (each) => each.tenantId === access.tenantId && each.admissionId === params.admissionId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = pageOf(request, own, (each) => each.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({ ...page, items: page.items.map(planView) });
  }),

  http.post('*/api/admissions/:admissionId/care-plans', async ({ request, params }) => {
    const access = authorize(request, { permission: 'carePlan:write', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = requireKey(request);
    if (key === null)
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const repeat = plans.find((each) => each.key === key && each.tenantId === access.tenantId);
    if (repeat) return HttpResponse.json(planView(repeat), { status: 201 });
    const body = (await request.json().catch(() => null)) as {
      problem?: unknown;
      goal?: unknown;
      tasks?: { description: string; dueAt?: string }[];
    } | null;
    if (!body || typeof body.problem !== 'string' || body.problem === '') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const user = currentSession()?.user;
    counter += 1;
    const plan: Stored<CarePlan> = {
      id: `plan_${counter}`,
      tenantId: access.tenantId,
      admissionId: String(params.admissionId),
      problem: body.problem,
      ...(typeof body.goal === 'string' ? { goal: body.goal } : {}),
      status: 'active',
      createdAt: new Date(Date.now() + counter).toISOString(),
      createdById: user?.id ?? '',
      createdByName: user?.name ?? '',
      tasks: (body.tasks ?? []).map((task, index) => ({
        id: `task_${counter}_${index}`,
        description: task.description,
        ...(task.dueAt ? { dueAt: task.dueAt } : {}),
      })),
      key,
    };
    plans.push(plan);
    return HttpResponse.json(planView(plan), { status: 201 });
  }),

  http.post('*/api/care-plans/:planId/tasks', async ({ request, params }) => {
    const access = authorize(request, { permission: 'carePlan:write', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const plan = plans.find(
      (each) => each.id === params.planId && each.tenantId === access.tenantId,
    );
    if (!plan) return error(404, 'plan_not_found', 'No such plan');
    if (plan.status !== 'active') return error(409, 'plan_closed', 'The plan has ended');
    const body = (await request.json().catch(() => null)) as { description?: unknown } | null;
    if (!body || typeof body.description !== 'string' || body.description === '') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    counter += 1;
    plan.tasks.push({ id: `task_${counter}`, description: body.description });
    return HttpResponse.json(planView(plan), { status: 201 });
  }),

  http.post('*/api/care-plan-tasks/:taskId/done', async ({ request, params }) => {
    const access = authorize(request, { permission: 'carePlan:write', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const plan = plans.find(
      (each) =>
        each.tenantId === access.tenantId && each.tasks.some((task) => task.id === params.taskId),
    );
    const task = plan?.tasks.find((each) => each.id === params.taskId);
    if (!plan || !task) return error(404, 'task_not_found', 'No such task');
    if (plan.status !== 'active') return error(409, 'plan_closed', 'The plan has ended');
    if (task.doneAt) return error(409, 'already_done', 'The task is already done');
    const body = (await request.json().catch(() => null)) as { note?: unknown } | null;
    const user = currentSession()?.user;
    task.doneAt = new Date().toISOString();
    task.doneById = user?.id ?? '';
    task.doneByName = user?.name ?? '';
    if (typeof body?.note === 'string') task.doneNote = body.note;
    return HttpResponse.json(planView(plan));
  }),

  http.post('*/api/care-plans/:planId/close', async ({ request, params }) => {
    const access = authorize(request, { permission: 'carePlan:write', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const plan = plans.find(
      (each) => each.id === params.planId && each.tenantId === access.tenantId,
    );
    if (!plan) return error(404, 'plan_not_found', 'No such plan');
    if (plan.status !== 'active') return error(409, 'plan_closed', 'The plan has ended');
    const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
    if (body?.status !== 'completed' && body?.status !== 'cancelled') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    plan.status = body.status;
    plan.closedAt = new Date().toISOString();
    return HttpResponse.json(planView(plan));
  }),
];
