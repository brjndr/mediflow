import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockAdmittedStays } from './admissions-flow';

type WardDietOrder = components['schemas']['WardDietOrder'];
type KitchenListItem = components['schemas']['KitchenListItem'];
type Stored = WardDietOrder & { tenantId: string; encounterId: string; key?: string };

let orders: Stored[] = [];
let counter = 0;
onMockReset(() => {
  orders = [];
  counter = 0;
});

/** For tests: a diet order already placed for a stay's encounter. */
export function addMockDietOrder(
  order: Partial<Stored> & { id: string; encounterId: string; instructions: string },
) {
  orders.push({
    tenantId: TENANT_IDS.hospital,
    status: 'placed',
    priority: 'routine',
    placedAt: new Date().toISOString(),
    ...order,
  });
}

const view = ({ tenantId: _t, encounterId: _e, key: _k, ...order }: Stored): WardDietOrder => order;
const newestFirst = (a: Stored, b: Stored) =>
  b.placedAt.localeCompare(a.placedAt) || b.id.localeCompare(a.id);
const LIVE = ['placed', 'accepted', 'in_progress'];

/**
 * Registered before the clinical mock: it places only a diet order (a stay's encounter is not one
 * the clinical mock holds) and lets every other type fall through to it.
 */
export const dietHandlers = [
  http.get('*/api/diet/kitchen-list', ({ request }) => {
    const access = authorize(request, { permission: 'order:read', featureFlag: 'nursing' });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const wardId = query.get('wardId');
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const all = mockAdmittedStays(access.tenantId).filter(
      (each) => !wardId || each.bed?.wardId === wardId,
    );
    const start = cursor ? all.findIndex((each) => each.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    const items = all.slice(start, start + limit).map((stay): KitchenListItem => {
      const diet = orders
        .filter(
          (each) =>
            each.tenantId === stay.tenantId &&
            each.encounterId === stay.encounterId &&
            LIVE.includes(each.status),
        )
        .sort(newestFirst)[0];
      return {
        admissionId: stay.id,
        patientId: stay.patientId,
        patientName: stay.patientName,
        patientMrn: stay.patientMrn,
        ...(stay.bed
          ? {
              wardId: stay.bed.wardId,
              wardName: stay.bed.wardName,
              roomName: stay.bed.roomName,
              bedNumber: stay.bed.bedNumber,
            }
          : {}),
        admittedAt: stay.admittedAt,
        diet: diet ? view(diet) : null,
      };
    });
    return HttpResponse.json({
      items,
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: all.length }),
    });
  }),

  http.get('*/api/admissions/:admissionId/diet', ({ request, params }) => {
    const access = authorize(request, { permission: 'order:read', featureFlag: 'nursing' });
    if ('denied' in access) return access.denied;
    const stay = mockAdmittedStays(access.tenantId).find((each) => each.id === params.admissionId);
    if (!stay) return error(404, 'admission_not_found', 'No such admission');
    return HttpResponse.json({
      items: orders
        .filter(
          (each) => each.tenantId === access.tenantId && each.encounterId === stay.encounterId,
        )
        .filter((each) => each.status !== 'cancelled')
        .sort(newestFirst)
        .map(view),
    });
  }),

  http.post('*/api/encounters/:encounterId/orders', async ({ request, params }) => {
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);
    if (typeof body !== 'object' || body === null || (body as { type?: unknown }).type !== 'diet') {
      return undefined;
    }
    const access = authorize(request, { permission: 'order:create', featureFlag: 'nursing' });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const sent = body as { instructions?: unknown; priority?: unknown };
    const instructions = typeof sent.instructions === 'string' ? sent.instructions.trim() : '';
    if (instructions === '' || instructions.length > 500) {
      return error(400, 'validation_failed', 'A diet order is its instructions');
    }
    const priority = sent.priority ?? 'routine';
    if (priority !== 'routine' && priority !== 'urgent' && priority !== 'stat') {
      return error(400, 'validation_failed', 'Bad priority');
    }
    const encounterId = String(params.encounterId);
    const stay = mockAdmittedStays(access.tenantId).find(
      (each) => each.encounterId === encounterId,
    );
    if (!stay) return error(409, 'encounter_not_open', 'The encounter is not open');
    const again = orders.find((each) => each.key === key && each.tenantId === access.tenantId);
    if (again) return HttpResponse.json(view(again), { status: 201 });
    counter += 1;
    const order: Stored = {
      id: `diet_${counter}`,
      tenantId: access.tenantId,
      encounterId,
      status: 'placed',
      priority,
      instructions,
      placedAt: new Date().toISOString(),
      key,
    };
    orders.push(order);
    return HttpResponse.json(view(order), { status: 201 });
  }),
];
