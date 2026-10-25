import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { nextDay, todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { currentSession, mockTenantTimezone, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockImagingOrders, moveMockOrder } from './clinical';
import { mockPatient, mockPatientDob } from './patients';
import { mockServiceModality } from './services';

type ImagingStage = components['schemas']['ImagingStage'];
type ImagingModality = components['schemas']['ImagingModality'];
type ImagingStudy = components['schemas']['ImagingStudy'];
type ImagingWorkItem = components['schemas']['ImagingWorkItem'];
type ImagingWorkItemPage = components['schemas']['ImagingWorkItemPage'];
type Order = components['schemas']['Order'];

const FEATURE_FLAG = 'radiology';
const STAGES: readonly ImagingStage[] = ['to_schedule', 'scheduled', 'performed'];
const MODALITIES: readonly ImagingModality[] = [
  'xray',
  'ct',
  'mri',
  'ultrasound',
  'mammography',
  'fluoroscopy',
  'nuclear',
  'other',
];
const PRIORITY_RANK: Record<Order['priority'], number> = { stat: 0, urgent: 1, routine: 2 };
const SLOT_MS = 15 * 60_000;
const DAYS_AHEAD = 90;

/**
 * Radiology's studies (#96), at most one per imaging order of the clinical mock, never removed:
 * unscheduling clears the time. As the API: scheduled, then performed, then never changed.
 */
function seed() {
  return {
    studies: [] as ImagingStudy[],
    answered: new Map<string, string>(),
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

const studyOf = (orderId: string) => state.studies.find((each) => each.orderId === orderId);

/** Where an order is in radiology, as the API's worklist works it out. */
function stageOf(order: Order): ImagingStage {
  const study = studyOf(order.id);
  if (study?.performedAt || order.status === 'in_progress') return 'performed';
  return study?.scheduledAt ? 'scheduled' : 'to_schedule';
}

const modalityOf = (order: Order): ImagingModality =>
  studyOf(order.id)?.modality ?? mockServiceModality(order.tenantId, order.serviceId ?? '');

function itemOf(order: Order): ImagingWorkItem {
  const patient = mockPatient(order.tenantId, order.patientId);
  const dob = mockPatientDob(order.tenantId, order.patientId);
  const study = studyOf(order.id);
  return {
    orderId: order.id,
    tenantId: order.tenantId,
    encounterId: order.encounterId,
    patientId: order.patientId,
    patientName: patient?.name ?? '',
    patientMrn: patient?.mrn ?? '',
    ...(dob ? { patientDob: dob } : {}),
    serviceId: order.serviceId ?? '',
    ...(order.itemCode ? { itemCode: order.itemCode } : {}),
    itemName: order.itemName ?? '',
    modality: modalityOf(order),
    priority: order.priority,
    ...(order.instructions ? { instructions: order.instructions } : {}),
    placedAt: order.placedAt,
    orderedByName: order.orderedByName,
    orderStatus: order.status,
    stage: stageOf(order),
    ...(study ? { study: { ...study } } : {}),
  };
}

/** The time a stage sorts by, as the API's worklist does. */
function sortAt(order: Order): string {
  const study = studyOf(order.id);
  const stage = stageOf(order);
  if (stage === 'performed') return study?.performedAt ?? order.statusChangedAt ?? order.placedAt;
  if (stage === 'scheduled') return study?.scheduledAt ?? order.placedAt;
  return order.placedAt;
}

/** An order still to be worked: not cancelled or completed. */
const active = (order: Order) => order.status !== 'cancelled' && order.status !== 'completed';

const orderFor = (tenantId: string, id: string) =>
  mockImagingOrders(tenantId).find((each) => each.id === id);

/**
 * The idempotency key of a POST: required, kept per hospital and user. A repeat with the same
 * body answers with the study as it is now; the same key with another body is refused.
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
  if (replay !== undefined && replay !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    } as const;
  }
  return { body, keyOf, replay: replay !== undefined } as const;
}

const orderNotFound = () => error(404, 'order_not_found', 'No such imaging order');
const conflict = () => error(409, 'conflict', 'The study has changed since it was read');

/** A start on a 15-minute step (422 `invalid_slot`). */
function slotRefusal(scheduledAt: unknown): Response | null {
  const at = typeof scheduledAt === 'string' ? new Date(scheduledAt).getTime() : Number.NaN;
  return Number.isNaN(at) || at % SLOT_MS !== 0
    ? error(422, 'invalid_slot', 'A study starts on a 15-minute step')
    : null;
}

/**
 * From the step under way to the end of the 90th day ahead at the hospital, as the API's window
 * (422 `outside_window`).
 */
function windowRefusal(tenantId: string, scheduledAt: string): Response | null {
  const timezone = mockTenantTimezone(tenantId);
  let day = todayIn(timezone);
  for (let n = 0; n <= DAYS_AHEAD; n += 1) day = nextDay(day);
  const at = new Date(scheduledAt).getTime();
  const current = Date.now() - (Date.now() % SLOT_MS);
  return at < current || at >= new Date(zonedToUtc(day, '00:00', timezone)).getTime()
    ? error(422, 'outside_window', 'A study is scheduled from now to 90 days ahead')
    : null;
}

/** A change of an order's study at the version sent, refused as the API refuses it. */
function changeHandler(
  path: 'unschedule' | 'perform',
  permission: string,
  change: (order: Order, study: ImagingStudy) => void,
) {
  return http.post(`*/api/radiology/orders/:orderId/${path}`, async ({ request, params }) => {
    const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const order = orderFor(access.tenantId, String(params.orderId));
    const study = order && studyOf(order.id);
    if (!order || !study) return orderNotFound();
    if (sent.replay) return HttpResponse.json<ImagingStudy>(study);
    const body = sent.body;
    if (!isObject(body) || !Number.isInteger(body.version)) {
      return error(400, 'validation_failed', 'A version is required');
    }
    if (body.version !== study.version) return conflict();
    if (order.status !== 'accepted' || study.performedAt || !study.scheduledAt) {
      return error(409, 'invalid_transition', `Only a scheduled study is ${path}d`);
    }
    change(order, study);
    study.version += 1;
    state.answered.set(sent.keyOf, JSON.stringify(body));
    return HttpResponse.json<ImagingStudy>(study);
  });
}

export const radiologyHandlers = [
  http.get('*/api/radiology/worklist', ({ request }) => {
    const access = authorize(request, {
      permission: 'imagingStudy:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const stage = query.get('stage') ?? 'to_schedule';
    const modality = query.get('modality');
    const priority = query.get('priority');
    const limit = Number(query.get('limit') ?? 25);
    if (
      !STAGES.includes(stage as ImagingStage) ||
      (modality !== null && !MODALITIES.includes(modality as ImagingModality)) ||
      (priority !== null && !(priority in PRIORITY_RANK)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const rank = (order: Order) => (stage === 'to_schedule' ? PRIORITY_RANK[order.priority] : 0);
    const items = mockImagingOrders(access.tenantId)
      .filter(active)
      .filter((order) => stageOf(order) === stage)
      .filter((order) => modality === null || modalityOf(order) === modality)
      .filter((order) => priority === null || order.priority === priority)
      .sort(
        (a, b) =>
          rank(a) - rank(b) || sortAt(a).localeCompare(sortAt(b)) || a.id.localeCompare(b.id),
      );
    const cursor = query.get('cursor');
    const first = cursor ? items.findIndex((each) => each.id === cursor) : 0;
    if (first < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = items[first + limit];
    return HttpResponse.json<ImagingWorkItemPage>({
      items: items.slice(first, first + limit).map(itemOf),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: items.length }),
    });
  }),

  http.post('*/api/radiology/orders/:orderId/schedule', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'imagingStudy:schedule',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const order = orderFor(tenantId, String(params.orderId));
    if (!order) return orderNotFound();
    const study = studyOf(order.id);
    if (sent.replay) return study ? HttpResponse.json<ImagingStudy>(study) : orderNotFound();
    const body = sent.body;
    if (!isObject(body) || typeof body.scheduledAt !== 'string') {
      return error(400, 'validation_failed', 'A time is required');
    }
    if (order.status !== 'placed' && order.status !== 'accepted') {
      return error(409, 'invalid_transition', `A ${order.status} order is not scheduled`);
    }
    if (study && body.version !== study.version) return conflict();
    if (study?.performedAt) return error(409, 'invalid_transition', 'Performed already');
    const refused = slotRefusal(body.scheduledAt);
    if (refused) return refused;
    const scheduledAt = new Date(body.scheduledAt).toISOString();
    // The slot it already has changes nothing, even once that slot has begun.
    const outside =
      study?.scheduledAt === scheduledAt ? null : windowRefusal(tenantId, scheduledAt);
    if (outside) return outside;
    if (study) {
      if (study.scheduledAt !== scheduledAt) {
        Object.assign(study, {
          scheduledAt,
          scheduledByName: callerOf().name,
          version: study.version + 1,
        });
      }
    } else {
      state.studies.push({
        id: `std_mock_${++state.counter}`,
        tenantId,
        orderId: order.id,
        encounterId: order.encounterId,
        patientId: order.patientId,
        modality: mockServiceModality(tenantId, order.serviceId ?? ''),
        scheduledAt,
        scheduledByName: callerOf().name,
        version: 1,
      });
    }
    if (order.status === 'placed') moveMockOrder(order.id, 'accepted');
    state.answered.set(sent.keyOf, JSON.stringify(body));
    const saved = studyOf(order.id);
    return saved ? HttpResponse.json<ImagingStudy>(saved) : orderNotFound();
  }),

  changeHandler('unschedule', 'imagingStudy:schedule', (_order, study) => {
    delete study.scheduledAt;
    delete study.scheduledByName;
  }),

  changeHandler('perform', 'imagingStudy:perform', (order, study) => {
    Object.assign(study, { performedAt: now(), performedByName: callerOf().name });
    moveMockOrder(order.id, 'in_progress');
  }),
];

/** The studies as the mock holds them, for tests. */
export const mockStudies = (): readonly ImagingStudy[] => state.studies;
