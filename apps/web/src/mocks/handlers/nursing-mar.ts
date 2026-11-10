import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type MarOrder = components['schemas']['MarOrder'];
type MarEntry = components['schemas']['MarEntry'];
type StoredOrder = MarOrder & { tenantId: string; admissionId: string };
type StoredEntry = MarEntry & { key: string };

const FEATURE_FLAG = 'nursing';

let orders: StoredOrder[] = [];
let entries: StoredEntry[] = [];
let counter = 0;
onMockReset(() => {
  orders = [];
  entries = [];
  counter = 0;
});

/** For tests: a medication order on a stay's chart. */
export function addMockMarOrder(
  order: Partial<MarOrder> & { id: string; admissionId: string; tenantId?: string },
) {
  orders.push({
    tenantId: TENANT_IDS.hospital,
    drugId: 'drug_x',
    itemName: 'Paracetamol 500 mg',
    dose: '500 mg',
    route: 'oral',
    frequency: 'BD',
    status: 'active',
    placedAt: '2026-11-01T00:00:00.000Z',
    dispensed: true,
    ...order,
  });
}

/** For tests: an entry already on the chart. */
export function addMockMarEntry(
  entry: Partial<MarEntry> & { id: string; admissionId: string; orderId: string },
) {
  entries.push({
    tenantId: TENANT_IDS.hospital,
    drugId: 'drug_x',
    scheduledAt: '2026-11-08T08:00:00.000Z',
    outcome: 'given',
    recordedAt: '2026-11-08T08:05:00.000Z',
    recordedById: 'user_nurse',
    recordedByName: 'Nurse Nandini',
    key: entry.id,
    ...entry,
  });
}

/** How many doses a day a frequency allows, as the API reads it; null for as needed. */
function dosesPerDay(frequency: string): number | null {
  const text = frequency.trim().toLowerCase();
  if (/^\d(-\d){1,3}$/.test(text)) {
    return text.split('-').reduce((sum, part) => sum + Number(part), 0);
  }
  const words: Record<string, number> = { od: 1, qd: 1, bd: 2, bid: 2, tds: 3, tid: 3, qid: 4 };
  return words[text] ?? null;
}

function pageOf<T extends { id: string }>(request: Request, all: T[], strip: (each: T) => unknown) {
  const query = new URL(request.url).searchParams;
  const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((each) => each.id === cursor) : 0;
  if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
  const next = all[start + limit];
  return HttpResponse.json({
    items: all.slice(start, start + limit).map(strip),
    nextCursor: next ? next.id : null,
    ...(cursor ? {} : { total: all.length }),
  });
}

const stripKey = ({ key: _key, ...each }: StoredEntry) => each;

function entryFrom(
  body: Record<string, unknown>,
  base: Pick<MarEntry, 'admissionId' | 'orderId' | 'drugId' | 'scheduledAt'>,
  order: MarOrder,
  tenantId: string,
  key: string,
): StoredEntry {
  counter += 1;
  const outcome = body.outcome as MarEntry['outcome'];
  const entry: StoredEntry = {
    id: `mar_${counter}`,
    tenantId,
    ...base,
    outcome,
    recordedAt: new Date().toISOString(),
    recordedById: currentSession()?.user.id ?? '',
    recordedByName: currentSession()?.user.name ?? '',
    key,
  };
  if (typeof body.reason === 'string' && body.reason !== '') entry.reason = body.reason;
  if (outcome === 'given') {
    entry.doseGiven = typeof body.doseGiven === 'string' ? body.doseGiven : order.dose;
    entry.route = typeof body.route === 'string' ? body.route : order.route;
    entry.administeredAt = new Date().toISOString();
  }
  if (!order.dispensed) entry.warnings = ['not_dispensed'];
  return entry;
}

export const marHandlers = [
  http.get('*/api/admissions/:admissionId/mar/orders', ({ request, params }) => {
    const access = authorize(request, { permission: 'mar:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const all = orders
      .filter(
        (each) => each.tenantId === access.tenantId && each.admissionId === params.admissionId,
      )
      .sort((a, b) => a.placedAt.localeCompare(b.placedAt));
    return pageOf(request, all, ({ tenantId: _t, admissionId: _a, ...each }) => each);
  }),

  http.get('*/api/admissions/:admissionId/mar', ({ request, params }) => {
    const access = authorize(request, { permission: 'mar:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const all = entries
      .filter(
        (each) => each.tenantId === access.tenantId && each.admissionId === params.admissionId,
      )
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt) || b.id.localeCompare(a.id));
    return pageOf(request, all, stripKey);
  }),

  http.post('*/api/mar/entries', async ({ request }) => {
    const access = authorize(request, { permission: 'mar:record', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const repeat = entries.find((each) => each.key === key && each.tenantId === access.tenantId);
    if (repeat) return HttpResponse.json(stripKey(repeat), { status: 201 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.orderId !== 'string' ||
      typeof body.admissionId !== 'string' ||
      typeof body.scheduledAt !== 'string' ||
      typeof body.outcome !== 'string'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const order = orders.find(
      (each) =>
        each.id === body.orderId &&
        each.tenantId === access.tenantId &&
        each.admissionId === body.admissionId,
    );
    if (!order) return error(404, 'admission_not_found', 'No such stay');
    if (order.status === 'cancelled') return error(409, 'order_cancelled', 'Order cancelled');
    const due = new Date(body.scheduledAt).getTime();
    if (
      entries.some(
        (each) =>
          each.orderId === order.id &&
          new Date(each.scheduledAt).getTime() === due &&
          each.correctedById === undefined,
      )
    ) {
      return error(409, 'slot_recorded', 'This dose was already charted');
    }
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (body.outcome !== 'given' && reason === '') {
      return error(422, 'reason_required', 'A reason is required');
    }
    if (body.outcome === 'given' && reason === '') {
      const limit = dosesPerDay(order.frequency);
      const given = entries.filter(
        (each) =>
          each.orderId === order.id &&
          each.outcome === 'given' &&
          each.correctedById === undefined &&
          Math.abs(new Date(each.scheduledAt).getTime() - due) < 24 * 3_600_000,
      ).length;
      if (limit !== null && given + 1 > limit) {
        return error(422, 'extra_dose_reason_required', 'A reason is required');
      }
    }
    const entry = entryFrom(
      body,
      {
        admissionId: order.admissionId,
        orderId: order.id,
        drugId: order.drugId,
        scheduledAt: body.scheduledAt,
      },
      order,
      access.tenantId,
      key,
    );
    entries.push(entry);
    return HttpResponse.json(stripKey(entry), { status: 201 });
  }),

  http.post('*/api/mar/entries/:entryId/correct', async ({ request, params }) => {
    const access = authorize(request, { permission: 'mar:record', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const repeat = entries.find((each) => each.key === key && each.tenantId === access.tenantId);
    if (repeat) return HttpResponse.json(stripKey(repeat), { status: 201 });
    const original = entries.find(
      (each) => each.id === params.entryId && each.tenantId === access.tenantId,
    );
    if (!original) return error(404, 'entry_not_found', 'No such entry');
    if (original.correctedById) return error(422, 'already_corrected', 'Already corrected');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.reason !== 'string' || body.reason === '') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const order = orders.find(
      (each) => each.id === original.orderId && each.tenantId === access.tenantId,
    );
    if (!order) return error(404, 'entry_not_found', 'No such entry');
    const correction = entryFrom(
      body,
      {
        admissionId: original.admissionId,
        orderId: original.orderId,
        drugId: original.drugId,
        scheduledAt: original.scheduledAt,
      },
      order,
      access.tenantId,
      key,
    );
    correction.correctsId = original.id;
    original.correctedById = correction.id;
    entries.push(correction);
    return HttpResponse.json(stripKey(correction), { status: 201 });
  }),
];
