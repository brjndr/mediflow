import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import { todayIn } from '@/shared/utils/timezone';
import { currentPolicy, currentSession, mockTenantTimezone, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockLabOrders, moveMockOrder } from './clinical';
import { mockLabAnalytes, mockLabTestSample } from './lab-tests';
import { mockPatient, mockPatientDob, mockPatientSex } from './patients';

type LabSample = components['schemas']['LabSample'];
type LabStage = components['schemas']['LabStage'];
type LabWorkItem = components['schemas']['LabWorkItem'];
type LabWorkItemPage = components['schemas']['LabWorkItemPage'];
type LabRejectReason = components['schemas']['LabRejectReason'];
type Order = components['schemas']['Order'];
type LabResult = components['schemas']['LabResult'];
type LabOrderResults = components['schemas']['LabOrderResults'];
type LabResultPage = components['schemas']['LabResultPage'];
type LabResultFlag = components['schemas']['LabResultFlag'];
type LabRange = NonNullable<LabResult['range']>;
type StoredResult = Omit<LabResult, 'amendedById'>;

const FEATURE_FLAG = 'laboratory';
const STAGES: readonly LabStage[] = ['to_collect', 'collected', 'received', 'completed'];
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
const VALUE_MAX = 500;
const COMMENT_MAX = 500;
const REASON_MAX = 200;
const RESULTS_MAX = 60;
// The API's decimal: up to nine digits before the point and six after.
const DECIMAL = /^-?\d{1,9}(\.\d{1,6})?$/;

/** A print the API would record in the audit log. */
export interface MockLabelPrint {
  tenantId: string;
  sampleId: string;
  userId: string;
}

/** A report print the API would record in the audit log (#92). */
export interface MockReportPrint {
  tenantId: string;
  orderId: string;
  userId: string;
}

/**
 * The laboratory's samples (#90), one or more per lab order of the clinical mock, never removed:
 * a rejected one stays and a new one is collected. Accession ids are numbered per hospital day.
 */
function seed() {
  return {
    samples: [] as LabSample[],
    // Results (#91), never removed or changed but for being verified once; `amendedById` is
    // worked out when read, as the API does.
    results: [] as StoredResult[],
    // When each order was completed, for the completed stage's order.
    completedAt: new Map<string, string>(),
    numbers: new Map<string, number>(),
    prints: [] as MockLabelPrint[],
    // Report prints (#92), as the API's audit log would hold them.
    reportPrints: [] as MockReportPrint[],
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
function stageOf(orderId: string, order?: Order): LabStage {
  if (order?.status === 'completed') return 'completed';
  const sample = liveSample(orderId);
  return sample ? (sample.status as LabStage) : 'to_collect';
}

function itemOf(order: Order): LabWorkItem {
  const patient = mockPatient(order.tenantId, order.patientId);
  const dob = mockPatientDob(order.tenantId, order.patientId);
  const sampleOf = order.labTestId ? mockLabTestSample(order.tenantId, order.labTestId) : undefined;
  const sample = newest(order.id);
  const standing = liveSample(order.id);
  const current = standing ? currentResults(standing.id) : [];
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
    stage: stageOf(order.id, order),
    ...(sample ? { sample } : {}),
    rejectedSamples: samplesOf(order.id).filter((each) => each.status === 'rejected').length,
    resultsEntered: current.length,
    resultsToVerify: current.filter((each) => each.status === 'entered').length,
  };
}

/** Every result of a sample, oldest first, each naming the correction that replaced it. */
function resultsOfSample(sampleId: string): LabResult[] {
  const held = state.results.filter((each) => each.sampleId === sampleId);
  return held.map((result) => {
    const by = held.find((each) => each.amendsId === result.id);
    return by ? { ...result, amendedById: by.id } : { ...result };
  });
}

const currentResults = (sampleId: string) =>
  resultsOfSample(sampleId).filter((each) => each.amendedById === undefined);

/** A number read against its range: the critical limits first, as the API does (#310). */
function flagOf(value: number, range: LabRange): LabResultFlag {
  if (range.criticalLow !== undefined && value <= range.criticalLow) return 'critical_low';
  if (range.criticalHigh !== undefined && value >= range.criticalHigh) return 'critical_high';
  if (range.low !== undefined && value < range.low) return 'low';
  if (range.high !== undefined && value > range.high) return 'high';
  return 'normal';
}

/** What a result of the order is entered for, with the patient's range on the collection day. */
function analytesOf(order: Order, sample: LabSample) {
  const dob = mockPatientDob(order.tenantId, order.patientId);
  const sex = mockPatientSex(order.tenantId, order.patientId);
  const on = todayIn(mockTenantTimezone(order.tenantId), new Date(sample.collectedAt));
  return order.labTestId
    ? mockLabAnalytes(order.tenantId, order.labTestId, dob && sex ? { sex, dob } : undefined, on)
    : [];
}

/**
 * The results of an order as the API gives them. A caller who may neither enter nor verify
 * results gets the verified ones only, and the tests still to verify by id (#91).
 */
function orderResultsOf(order: Order): LabOrderResults {
  const sample = liveSample(order.id);
  const all = sample ? resultsOfSample(sample.id) : [];
  const works = (currentPolicy()?.permissions ?? []).some(
    (grant) =>
      (grant.permission === 'labResult:enter' || grant.permission === 'labResult:verify') &&
      (grant.scope ?? 'all') === 'all',
  );
  return {
    orderId: order.id,
    tenantId: order.tenantId,
    encounterId: order.encounterId,
    patientId: order.patientId,
    patientName: mockPatient(order.tenantId, order.patientId)?.name ?? '',
    patientMrn: mockPatient(order.tenantId, order.patientId)?.mrn ?? '',
    itemName: order.itemName ?? '',
    priority: order.priority,
    orderStatus: order.status,
    ...(sample ? { sample } : {}),
    analytes: sample ? analytesOf(order, sample) : [],
    results: works ? all : all.filter((each) => each.status === 'verified'),
    ...(works
      ? {}
      : {
          awaitingVerification: all
            .filter((each) => each.status === 'entered' && each.amendedById === undefined)
            .map((each) => each.labTestId),
        }),
  };
}

/** A result's value as the API keeps it, or the refusal. */
function valueOf(
  resultType: 'numeric' | 'text',
  value: unknown,
): { value: string; number?: number } | { refused: Response } {
  if (typeof value !== 'string' || !value.trim() || value.length > VALUE_MAX) {
    return { refused: error(400, 'validation_failed', 'A result is required') };
  }
  if (resultType === 'numeric') {
    const typed = value.trim();
    if (!DECIMAL.test(typed)) {
      return { refused: error(422, 'invalid_number', 'A numeric result is a decimal number') };
    }
    // Leading zeros go and the decimals stay, as in the database (`007.50` is `7.50`).
    const kept = typed.replace(/^(-?)0+(?=\d)/, '$1');
    return { value: kept, number: Number(kept) };
  }
  if (!PLAIN_LINES.test(value)) return { refused: error(400, 'validation_failed', 'Plain text') };
  return { value: value.trim() };
}

/** An optional comment, tidied, or false when the API would refuse it. */
function commentOf(comment: unknown): { comment?: string } | false {
  if (comment === undefined) return {};
  return typeof comment === 'string' &&
    comment.trim() &&
    comment.length <= COMMENT_MAX &&
    PLAIN_LINES.test(comment)
    ? { comment: comment.trim() }
    : false;
}

interface Analyte {
  labTestId: string;
  code: string;
  name: string;
  resultType: 'numeric' | 'text';
  unit?: string;
}

/** A result written as the API writes it, read against the range it is given. */
function newResult(
  sample: LabSample,
  test: Analyte,
  range: LabRange | undefined,
  value: { value: string; number?: number },
  comment: string | undefined,
  amends?: { id: string; reason: string },
): StoredResult {
  const kept = test.resultType === 'numeric' ? range : undefined;
  return {
    id: `res_mock_${++state.counter}`,
    tenantId: sample.tenantId,
    sampleId: sample.id,
    orderId: sample.orderId,
    encounterId: sample.encounterId,
    patientId: sample.patientId,
    labTestId: test.labTestId,
    testCode: test.code,
    testName: test.name,
    resultType: test.resultType,
    value: value.value,
    ...(test.resultType === 'numeric' && test.unit ? { unit: test.unit } : {}),
    ...(kept ? { range: kept } : {}),
    ...(kept && value.number !== undefined ? { flag: flagOf(value.number, kept) } : {}),
    ...(comment ? { comment } : {}),
    status: 'entered',
    enteredAt: now(),
    enteredByName: callerOf().name,
    collectedAt: sample.collectedAt,
    ...(amends ? { amendsId: amends.id, amendmentReason: amends.reason } : {}),
    version: 1,
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
    // Open stages stat first and the oldest first; completed the newest completed first.
    const completed = stage === 'completed';
    const completedAt = (order: Order) => state.completedAt.get(order.id) ?? order.placedAt;
    const items = mockLabOrders(access.tenantId)
      .filter((order) => (completed ? order.status === 'completed' : active(order)))
      .filter((order) => completed || stageOf(order.id) === stage)
      .filter((order) => priority === null || order.priority === priority)
      .sort((a, b) =>
        completed
          ? completedAt(b).localeCompare(completedAt(a)) || b.id.localeCompare(a.id)
          : PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
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
      ...(cursor || completed ? {} : { total: items.length }),
    });
  }),

  http.get('*/api/lab/orders/:orderId/results', ({ request, params }) => {
    const access = authorize(request, { permission: 'labResult:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const order = orderFor(access.tenantId, String(params.orderId));
    if (!order) return error(404, 'order_not_found', 'Order not found');
    return HttpResponse.json<LabOrderResults>(orderResultsOf(order));
  }),

  http.post('*/api/lab/samples/:sampleId/results', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'labResult:enter',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const sample = sampleFor(tenantId, String(params.sampleId));
    const order = sample && orderFor(tenantId, sample.orderId);
    if (!sample || !order) return sampleNotFound();
    if (sent.replay) {
      return HttpResponse.json<LabOrderResults>(orderResultsOf(order), { status: 201 });
    }
    const body = sent.body;
    const entries = isObject(body) && Array.isArray(body.results) ? body.results : null;
    const ids = (entries ?? []).map((entry: unknown) =>
      isObject(entry) ? entry.labTestId : undefined,
    );
    if (
      !entries ||
      entries.length < 1 ||
      entries.length > RESULTS_MAX ||
      !ids.every((id) => typeof id === 'string') ||
      new Set(ids).size !== ids.length
    ) {
      return error(400, 'validation_failed', 'Each test is entered once');
    }
    if (!active(order) || sample.status !== 'received') {
      return error(409, 'invalid_transition', 'The sample takes no results');
    }
    const analytes = new Map(analytesOf(order, sample).map((each) => [each.labTestId, each]));
    const resulted = new Set(resultsOfSample(sample.id).map((each) => each.labTestId));
    const written: StoredResult[] = [];
    for (const entry of entries as Record<string, unknown>[]) {
      const analyte = analytes.get(String(entry.labTestId));
      if (!analyte) return error(422, 'unknown_test', 'The test is not of this order');
      if (resulted.has(analyte.labTestId)) {
        return error(409, 'already_resulted', 'The test has a result; correct it instead');
      }
      const value = valueOf(analyte.resultType, entry.value);
      if ('refused' in value) return value.refused;
      const comment = commentOf(entry.comment);
      if (!comment) return error(400, 'validation_failed', 'The comment is not valid');
      written.push(newResult(sample, analyte, analyte.range, value, comment.comment));
    }
    // All or nothing, as the API's transaction.
    state.results.push(...written);
    if (order.status === 'accepted') moveMockOrder(order.id, 'in_progress');
    remember(sent.keyOf, body, sample.id);
    return HttpResponse.json<LabOrderResults>(orderResultsOf(order), { status: 201 });
  }),

  http.post('*/api/lab/samples/:sampleId/verify', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'labResult:verify',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const sample = sampleFor(tenantId, String(params.sampleId));
    const order = sample && orderFor(tenantId, sample.orderId);
    if (!sample || !order) return sampleNotFound();
    if (sent.replay) return HttpResponse.json<LabOrderResults>(orderResultsOf(order));
    const body = sent.body;
    const ids = isObject(body) && Array.isArray(body.resultIds) ? body.resultIds : null;
    if (
      !ids ||
      ids.length < 1 ||
      ids.length > RESULTS_MAX ||
      !ids.every((id) => typeof id === 'string')
    ) {
      return error(400, 'validation_failed', 'The results read are required');
    }
    if (order.status === 'cancelled') {
      return error(409, 'invalid_transition', 'A cancelled order is not verified');
    }
    const held = resultsOfSample(sample.id);
    const named = [...new Set(ids as string[])];
    for (const id of named) {
      const result = held.find((each) => each.id === id);
      if (!result) return error(422, 'unknown_result', 'The result is not of this sample');
      if (result.amendedById !== undefined || result.status !== 'entered') {
        return error(409, 'conflict', 'The result has changed since it was read');
      }
    }
    for (const stored of state.results.filter((each) => named.includes(each.id))) {
      Object.assign(stored, {
        status: 'verified',
        verifiedAt: now(),
        verifiedByName: callerOf().name,
        version: stored.version + 1,
      });
    }
    const verified = new Set(
      currentResults(sample.id)
        .filter((each) => each.status === 'verified')
        .map((each) => each.labTestId),
    );
    const analytes = analytesOf(order, sample);
    if (
      order.status === 'in_progress' &&
      analytes.length > 0 &&
      analytes.every((each) => verified.has(each.labTestId))
    ) {
      moveMockOrder(order.id, 'completed');
      state.completedAt.set(order.id, now());
    }
    remember(sent.keyOf, body, sample.id);
    return HttpResponse.json<LabOrderResults>(orderResultsOf(order));
  }),

  http.post('*/api/lab/results/:resultId/amend', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'labResult:enter',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const resultFor = (id: string) => {
      const stored = state.results.find((each) => each.id === id && each.tenantId === tenantId);
      return stored && resultsOfSample(stored.sampleId).find((each) => each.id === id);
    };
    const notFound = () => error(404, 'result_not_found', 'Result not found');
    if (sent.replay) {
      const again = resultFor(sent.replay.id);
      return again ? HttpResponse.json<LabResult>(again, { status: 201 }) : notFound();
    }
    const body = sent.body;
    const reason = isObject(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!isObject(body) || !reason || reason.length > REASON_MAX || !PLAIN_TEXT.test(reason)) {
      return error(400, 'validation_failed', 'A reason is required');
    }
    const found = resultFor(String(params.resultId));
    const sample = found && sampleFor(tenantId, found.sampleId);
    const order = sample && orderFor(tenantId, sample.orderId);
    if (!found || !sample || !order) return notFound();
    if (order.status === 'cancelled') {
      return error(409, 'invalid_transition', 'A cancelled order is not corrected');
    }
    if (found.amendedById !== undefined) {
      return error(409, 'already_amended', 'The result was corrected already');
    }
    const value = valueOf(found.resultType, body.value);
    if ('refused' in value) return value.refused;
    const comment = commentOf(body.comment);
    if (!comment) return error(400, 'validation_failed', 'The comment is not valid');
    const analyte: Analyte = {
      labTestId: found.labTestId,
      code: found.testCode,
      name: found.testName,
      resultType: found.resultType,
      ...(found.unit ? { unit: found.unit } : {}),
    };
    const amended = newResult(sample, analyte, found.range, value, comment.comment, {
      id: found.id,
      reason,
    });
    state.results.push(amended);
    remember(sent.keyOf, body, amended.id);
    return HttpResponse.json<LabResult>({ ...amended }, { status: 201 });
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

  // ----- Reports, acknowledgements and a patient's results (#92) -----

  http.post('*/api/lab/results/search', async ({ request }) => {
    const access = authorize(request, { permission: 'labResult:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body: unknown = await request.json().catch(() => null);
    if (!isObject(body) || typeof body.patientId !== 'string') {
      return error(400, 'validation_failed', 'The patient is required');
    }
    const limit = body.limit === undefined ? 25 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const items = releasedOf(access.tenantId, body.patientId).filter(
      (each) =>
        (body.labTestId === undefined || each.labTestId === body.labTestId) &&
        (body.encounterId === undefined || each.encounterId === body.encounterId),
    );
    const cursor = typeof body.cursor === 'string' ? body.cursor : null;
    const first = cursor ? items.findIndex((each) => each.id === cursor) : 0;
    if (first < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = items[first + limit];
    return HttpResponse.json<LabResultPage>({
      items: items.slice(first, first + limit),
      nextCursor: next ? next.id : null,
    });
  }),

  http.post('*/api/lab/results/:resultId/acknowledge', async ({ request, params }) => {
    for (const permission of ['labResult:read', 'labResult:acknowledge']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const stored = state.results.find(
      (each) => each.id === String(params.resultId) && each.tenantId === tenantId,
    );
    if (!stored) return error(404, 'result_not_found', 'Result not found');
    if (!sent.replay) {
      if (stored.acknowledgedAt) {
        return error(409, 'already_acknowledged', 'The result was acknowledged already');
      }
      if (stored.status !== 'verified' || !isCritical(stored.flag)) {
        return error(409, 'not_acknowledgeable', 'Only a verified critical result is acknowledged');
      }
      Object.assign(stored, { acknowledgedAt: now(), acknowledgedByName: callerOf().name });
      remember(sent.keyOf, sent.body, stored.id);
    }
    const result = resultsOfSample(stored.sampleId).find((each) => each.id === stored.id);
    return HttpResponse.json<LabResult>(result ?? { ...stored });
  }),

  http.post('*/api/lab/orders/:orderId/print', async ({ request, params }) => {
    for (const permission of ['labResult:read', 'labReport:print']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const order = orderFor(tenantId, String(params.orderId));
    if (!order) return error(404, 'order_not_found', 'Order not found');
    if (!sent.replay) {
      const sample = liveSample(order.id);
      const results = sample ? resultsOfSample(sample.id) : [];
      if (!results.some((each) => each.status === 'verified')) {
        return error(409, 'not_printable', 'The order has no verified result');
      }
      state.reportPrints.push({ tenantId, orderId: order.id, userId: callerOf().id });
      remember(sent.keyOf, sent.body, order.id);
    }
    return new HttpResponse(null, { status: 204 });
  }),
];

const isCritical = (flag: LabResultFlag | undefined) =>
  flag === 'critical_low' || flag === 'critical_high';

/**
 * A patient's released results as the API gives them (#92): of each test of each sample, the
 * newest verified result, the newest collected first.
 */
function releasedOf(tenantId: string, patientId: string): LabResult[] {
  const newestVerified = new Map<string, LabResult>();
  for (const sample of state.samples) {
    if (sample.tenantId !== tenantId || sample.patientId !== patientId) continue;
    for (const result of resultsOfSample(sample.id)) {
      if (result.status === 'verified')
        newestVerified.set(`${sample.id}:${result.labTestId}`, result);
    }
  }
  return [...newestVerified.values()].sort(
    (a, b) => b.collectedAt.localeCompare(a.collectedAt) || b.id.localeCompare(a.id),
  );
}

/**
 * For tests and the examples: a received sample of a mock lab order with every test of it
 * entered and verified (`values` by test code; a test not named gets `fallback`), the order
 * completed, as the laboratory would leave it. Gives the results.
 */
export function releaseMockResults(
  tenantId: string,
  orderId: string,
  values: Record<string, string>,
  { fallback = '1', collectedAt = now() }: { fallback?: string; collectedAt?: string } = {},
): LabResult[] {
  const order = orderFor(tenantId, orderId);
  if (!order) throw new Error(`no lab order ${orderId}`);
  const sample: LabSample = {
    id: `smp_mock_${++state.counter}`,
    tenantId,
    orderId: order.id,
    encounterId: order.encounterId,
    patientId: order.patientId,
    accessionId: nextAccession(tenantId),
    sampleType: 'blood',
    status: 'received',
    collectedAt,
    collectedByName: 'Lab Technician',
    receivedAt: collectedAt,
    receivedByName: 'Lab Technician',
    version: 2,
  };
  state.samples.push(sample);
  for (const test of analytesOf(order, sample)) {
    const typed = values[test.code] ?? fallback;
    const result = newResult(
      sample,
      test,
      test.range,
      test.resultType === 'numeric' ? { value: typed, number: Number(typed) } : { value: typed },
      undefined,
    );
    state.results.push({
      ...result,
      enteredByName: 'Lab Technician',
      status: 'verified',
      verifiedAt: collectedAt,
      verifiedByName: 'Lab Technician',
      version: 2,
    });
  }
  if (active(order)) {
    moveMockOrder(order.id, 'completed');
    state.completedAt.set(order.id, now());
  }
  return resultsOfSample(sample.id);
}

/** The report prints the API's audit log would hold (#92), for tests. */
export const mockReportPrints = (): readonly MockReportPrint[] => state.reportPrints;

/** The samples of a lab order as the mock holds them, oldest first, for tests. */
export const mockSamplesOf = (orderId: string): readonly LabSample[] => samplesOf(orderId);

/** The results of a sample as the mock holds them, corrections included, for tests. */
export const mockResultsOf = (sampleId: string): readonly LabResult[] => resultsOfSample(sampleId);

/** The label prints the API's audit log would hold, for tests. */
export const mockLabelPrints = (): readonly MockLabelPrint[] => state.prints;
