import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { todayIn } from '@/shared/utils/timezone';
import { currentPolicy, currentSession, mockTenantTimezone, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockLabOrders, moveMockOrder } from './clinical';
import { mockLabTestSample } from './lab-tests';
import { mockPatient, mockPatientDob } from './patients';

type LabSample = components['schemas']['LabSample'];
type LabStage = components['schemas']['LabStage'];
type LabWorkItem = components['schemas']['LabWorkItem'];
type LabWorkItemPage = components['schemas']['LabWorkItemPage'];
type LabRejectReason = components['schemas']['LabRejectReason'];
type Order = components['schemas']['Order'];

const FEATURE_FLAG = 'laboratory';
const STAGES: readonly LabStage[] = ['to_collect', 'collected', 'received'];
const PRIORITY_RANK: Record<Order['priority'], number> = { stat: 0, urgent: 1, routine: 2 };
const REASONS: readonly LabRejectReason[] = [
  'haemolysed',
  'clotted',
  'insufficient',
  'mislabelled',
  'wrong_container',
  'contaminated',
  'other',
];
const NOTE_MAX = 200;

/** A print the API would record in the audit log. */
export interface MockLabelPrint {
  tenantId: string;
  sampleId: string;
  userId: string;
}

/**
 * The laboratory's samples (#90), one or more per lab order of the clinical mock, never removed:
 * a rejected one stays and a new one is collected. Accession ids are numbered per hospital day.
 */
function seed() {
  return {
    samples: [] as LabSample[],
    numbers: new Map<string, number>(),
    prints: [] as MockLabelPrint[],
    answered: new Map<string, { body: string; id: string }>(),
    counter: 0,
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

const now = () => new Date().toISOString();
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const callerOf = () => currentSession()?.user ?? { id: '', name: '' };

/** The next accession id of the hospital's day: `YYMMDD-NNNN`. */
function nextAccession(tenantId: string): string {
  const day = todayIn(mockTenantTimezone(tenantId)).replaceAll('-', '').slice(2);
  const key = `${tenantId}:${day}`;
  const number = (state.numbers.get(key) ?? 0) + 1;
  state.numbers.set(key, number);
  return `${day}-${String(number).padStart(4, '0')}`;
}

const samplesOf = (orderId: string) => state.samples.filter((each) => each.orderId === orderId);
const newest = (orderId: string) => samplesOf(orderId).at(-1);
const liveSample = (orderId: string) => {
  const sample = newest(orderId);
  return sample && sample.status !== 'rejected' ? sample : undefined;
};

/** Where an order is in the laboratory: collected again once its last sample is rejected. */
function stageOf(orderId: string): LabStage {
  const sample = liveSample(orderId);
  return sample ? (sample.status as LabStage) : 'to_collect';
}

function itemOf(order: Order): LabWorkItem {
  const patient = mockPatient(order.tenantId, order.patientId);
  const dob = mockPatientDob(order.tenantId, order.patientId);
  const sampleOf = order.labTestId ? mockLabTestSample(order.tenantId, order.labTestId) : undefined;
  const sample = newest(order.id);
  return {
    orderId: order.id,
    tenantId: order.tenantId,
    encounterId: order.encounterId,
    patientId: order.patientId,
    patientName: patient?.name ?? '',
    patientMrn: patient?.mrn ?? '',
    ...(dob ? { patientDob: dob } : {}),
    ...(order.labTestId ? { labTestId: order.labTestId } : {}),
    ...(order.itemCode ? { itemCode: order.itemCode } : {}),
    itemName: order.itemName ?? '',
    priority: order.priority,
    ...(order.instructions ? { instructions: order.instructions } : {}),
    placedAt: order.placedAt,
    orderedByName: order.orderedByName,
    orderStatus: order.status,
    sampleType: sampleOf?.sampleType ?? 'other',
    ...(sampleOf?.container ? { container: sampleOf.container } : {}),
    stage: stageOf(order.id),
    ...(sample ? { sample } : {}),
    rejectedSamples: samplesOf(order.id).filter((each) => each.status === 'rejected').length,
  };
}

/** An order still to be worked: not cancelled or completed. */
const active = (order: Order) => order.status !== 'cancelled' && order.status !== 'completed';

const orderFor = (tenantId: string, id: string) =>
  mockLabOrders(tenantId).find((each) => each.id === id);

const sampleFor = (tenantId: string, id: string) =>
  state.samples.find((each) => each.id === id && each.tenantId === tenantId);

/**
 * The idempotency key of a POST: required, kept per hospital and user. A repeat with the same
 * body answers with what is true now; the same key with another body is refused.
 */
async function idempotent(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  if (!key) {
    return { refused: error(400, 'validation_failed', 'Idempotency-Key is required') } as const;
  }
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : null;
  const keyOf = `${tenantId}:${callerOf().id}:${new URL(request.url).pathname}:${key}`;
  const replay = state.answered.get(keyOf);
  if (replay && replay.body !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    } as const;
  }
  return { body, keyOf, replay } as const;
}

const remember = (keyOf: string, body: unknown, id: string) =>
  state.answered.set(keyOf, { body: JSON.stringify(body), id });

const sampleNotFound = () => error(404, 'sample_not_found', 'Sample not found');

export const labHandlers = [
  http.get('*/api/lab/worklist', ({ request }) => {
    const access = authorize(request, { permission: 'labSample:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const stage = query.get('stage') ?? 'to_collect';
    const priority = query.get('priority');
    const limit = Number(query.get('limit') ?? 25);
    if (
      !STAGES.includes(stage as LabStage) ||
      (priority !== null && !(priority in PRIORITY_RANK)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const items = mockLabOrders(access.tenantId)
      .filter(active)
      .filter((order) => stageOf(order.id) === stage)
      .filter((order) => priority === null || order.priority === priority)
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          a.placedAt.localeCompare(b.placedAt) ||
          a.id.localeCompare(b.id),
      );
    const cursor = query.get('cursor');
    const first = cursor ? items.findIndex((each) => each.id === cursor) : 0;
    if (first < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = items[first + limit];
    return HttpResponse.json<LabWorkItemPage>({
      items: items.slice(first, first + limit).map(itemOf),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: items.length }),
    });
  }),

  http.post('*/api/lab/orders/:orderId/samples', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'labSample:collect',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const order = orderFor(tenantId, String(params.orderId));
    if (!order) return error(404, 'order_not_found', 'Order not found');
    if (sent.replay) {
      const again = sampleFor(tenantId, sent.replay.id);
      if (again) return HttpResponse.json<LabSample>(again, { status: 201 });
    }
    if (!active(order)) {
      return error(409, 'invalid_transition', `A ${order.status} order is not collected`);
    }
    if (liveSample(order.id)) return error(409, 'already_collected', 'Already collected');
    const sampleOf = order.labTestId ? mockLabTestSample(tenantId, order.labTestId) : undefined;
    const sample: LabSample = {
      id: `smp_mock_${++state.counter}`,
      tenantId,
      orderId: order.id,
      encounterId: order.encounterId,
      patientId: order.patientId,
      accessionId: nextAccession(tenantId),
      sampleType: sampleOf?.sampleType ?? 'other',
      ...(sampleOf?.container ? { container: sampleOf.container } : {}),
      status: 'collected',
      collectedAt: now(),
      collectedByName: callerOf().name,
      version: 1,
    };
    state.samples.push(sample);
    if (order.status === 'placed') moveMockOrder(order.id, 'accepted');
    remember(sent.keyOf, sent.body, sample.id);
    return HttpResponse.json<LabSample>(sample, { status: 201 });
  }),

  http.post('*/api/lab/samples/:sampleId/receive', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'labSample:receive',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const sample = sampleFor(tenantId, String(params.sampleId));
    if (!sample) return sampleNotFound();
    if (sent.replay) return HttpResponse.json<LabSample>(sample);
    const body = sent.body;
    if (!isObject(body) || !Number.isInteger(body.version)) {
      return error(400, 'validation_failed', 'A version is required');
    }
    if (body.version !== sample.version) return error(409, 'conflict', 'Changed meanwhile');
    const order = orderFor(tenantId, sample.orderId);
    if (sample.status !== 'collected' || !order || !active(order)) {
      return error(409, 'invalid_transition', `A ${sample.status} sample is not received`);
    }
    Object.assign(sample, {
      status: 'received',
      receivedAt: now(),
      receivedByName: callerOf().name,
      version: sample.version + 1,
    });
    // The order is left accepted: it goes in progress when its result is first entered (#91).
    remember(sent.keyOf, body, sample.id);
    return HttpResponse.json<LabSample>(sample);
  }),

  http.post('*/api/lab/samples/:sampleId/reject', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'labSample:reject',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const sample = sampleFor(tenantId, String(params.sampleId));
    if (!sample) return sampleNotFound();
    if (sent.replay) return HttpResponse.json<LabSample>(sample);
    const body = sent.body;
    const note = isObject(body) && typeof body.note === 'string' ? body.note.trim() : undefined;
    if (
      !isObject(body) ||
      !Number.isInteger(body.version) ||
      !REASONS.includes(body.reason as LabRejectReason) ||
      (body.note !== undefined && (!note || note.length > NOTE_MAX || !PLAIN_TEXT.test(note))) ||
      (body.reason === 'other' && !note)
    ) {
      return error(400, 'validation_failed', 'A version and a reason are required');
    }
    if (body.version !== sample.version) return error(409, 'conflict', 'Changed meanwhile');
    const order = orderFor(tenantId, sample.orderId);
    if (sample.status === 'rejected' || !order || !active(order)) {
      return error(409, 'invalid_transition', `A ${sample.status} sample is not rejected`);
    }
    Object.assign(sample, {
      status: 'rejected',
      rejectedAt: now(),
      rejectedByName: callerOf().name,
      rejectReason: body.reason as LabRejectReason,
      ...(note ? { rejectNote: note } : {}),
      version: sample.version + 1,
    });
    remember(sent.keyOf, body, sample.id);
    return HttpResponse.json<LabSample>(sample);
  }),

  // A label print: an audit entry, nothing else.
  http.post('*/api/lab/samples/:sampleId/print', async ({ request, params }) => {
    for (const permission of ['labSample:read', 'labSample:collect']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const sample = sampleFor(tenantId, String(params.sampleId));
    if (!sample) return sampleNotFound();
    if (sample.status === 'rejected') {
      return error(409, 'not_printable', 'A rejected sample is not labelled');
    }
    if (!sent.replay) {
      state.prints.push({ tenantId, sampleId: sample.id, userId: callerOf().id });
      remember(sent.keyOf, sent.body, sample.id);
    }
    return new HttpResponse(null, { status: 204 });
  }),
];

/** The samples of a lab order as the mock holds them, oldest first, for tests. */
export const mockSamplesOf = (orderId: string): readonly LabSample[] => samplesOf(orderId);

/** The label prints the API's audit log would hold, for tests. */
export const mockLabelPrints = (): readonly MockLabelPrint[] => state.prints;
