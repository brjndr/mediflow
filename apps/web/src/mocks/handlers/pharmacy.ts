import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { currentSession, mockTenantTimezone, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockMedicationPrescriptions, moveMockOrder } from './clinical';
import { mockDrug, mockDrugsOf } from './drugs';
import { mockStockIn, mockStockOut, mockUsableBatches } from './inventory';
import { mockPatient } from './patients';

type Drug = components['schemas']['Drug'];
type Order = components['schemas']['Order'];
type Prescription = components['schemas']['Prescription'];
type Dispense = components['schemas']['Dispense'];
type PharmacyLine = components['schemas']['PharmacyLine'];
type PharmacyPrescription = components['schemas']['PharmacyPrescription'];
type PharmacyQueueItem = components['schemas']['PharmacyQueueItem'];
type DispensableItem = components['schemas']['DispensableItem'];

const FEATURE_FLAG = 'pharmacy';
const READ = 'dispense:read';
const CREATE = 'dispense:create';
const RETURN = 'dispense:return';
const DAY_MS = 86_400_000;
const OPEN: readonly Order['status'][] = ['placed', 'accepted', 'in_progress'];

/**
 * The pharmacy (#100), as the API: the queue of the clinical mock's prescriptions, dispensing a
 * line from batches at a place through the inventory mock (`mockStockOut`), generic substitutes
 * from the drugs mock, and moving the order on with `moveMockOrder`; returns of a dispense to
 * stock or as wastage through `mockStockIn` (#104). Nothing dispensed at first.
 */
function seed() {
  return {
    dispenses: [] as Dispense[],
    prints: [] as { tenantId: string; dispenseId: string; userId: string }[],
    answered: new Map<string, { body: string; reply: unknown; status: number }>(),
    counter: 0,
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** For tests: the dispenses and printed slips as the mock holds them. */
export const mockDispenses = () => ({ dispenses: state.dispenses, prints: state.prints });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const callerOf = () => currentSession()?.user ?? { id: '', name: '' };
const invalid = (message = 'The request is not valid') => error(400, 'validation_failed', message);
const orderNotFound = () => error(404, 'order_not_found', 'No such order');

/** A write answers with the patient's record, so it needs both permissions, as the API. */
function authorizeWrite(request: Request) {
  const read = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
  if ('denied' in read) return read;
  return authorize(request, { permission: CREATE, featureFlag: FEATURE_FLAG });
}

/** The idempotency key of a POST, per hospital and user: a repeat answers as the first did. */
async function idempotent(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : null;
  const keyOf = key ? `${tenantId}:${callerOf().id}:${new URL(request.url).pathname}:${key}` : null;
  const earlier = keyOf ? state.answered.get(keyOf) : undefined;
  if (earlier && earlier.body !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    } as const;
  }
  const answer = (reply: unknown, status = 200) => {
    if (keyOf) state.answered.set(keyOf, { body: JSON.stringify(body), reply, status });
    return status === 204
      ? new HttpResponse(null, { status })
      : HttpResponse.json(reply as Record<string, unknown>, { status });
  };
  return {
    body,
    answer,
    replay: earlier
      ? earlier.status === 204
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json(earlier.reply as Record<string, unknown>, { status: earlier.status })
      : null,
  } as const;
}

const medicationLines = (rx: Prescription) => rx.lines.filter((line) => line.type === 'medication');
const dispensedOf = (orderId: string) =>
  state.dispenses
    .filter((each) => each.orderId === orderId)
    .reduce((sum, each) => sum + each.quantity, 0);

function lineView(order: Order): PharmacyLine {
  return {
    orderId: order.id,
    lineNumber: order.lineNumber ?? 0,
    version: order.version,
    status: order.status,
    drugId: order.drugId ?? '',
    itemName: order.itemName ?? '',
    dose: order.dose ?? '',
    frequency: order.frequency ?? '',
    route: order.route ?? 'oral',
    ...(order.durationDays === undefined ? {} : { durationDays: order.durationDays }),
    ...(order.quantity === undefined ? {} : { quantity: order.quantity }),
    ...(order.instructions === undefined ? {} : { instructions: order.instructions }),
    ...(order.cancelReason === undefined ? {} : { cancelReason: order.cancelReason }),
    dispensedQuantity: dispensedOf(order.id),
  };
}

function prescriptionView(tenantId: string, rx: Prescription): PharmacyPrescription {
  const patient = mockPatient(tenantId, rx.patientId);
  return {
    prescriptionId: rx.id,
    encounterId: rx.encounterId,
    patientId: rx.patientId,
    patientName: patient?.name ?? '',
    patientMrn: patient?.mrn ?? '',
    prescribedAt: rx.prescribedAt,
    prescribedByName: rx.prescribedByName,
    ...(rx.advice === undefined ? {} : { advice: rx.advice }),
    ...(rx.replacesId === undefined ? {} : { replacesId: rx.replacesId }),
    ...(rx.replacedById === undefined ? {} : { replacedById: rx.replacedById }),
    lines: medicationLines(rx).map(lineView),
    dispenses: state.dispenses
      .filter((each) => each.prescriptionId === rx.id)
      .sort((a, b) => a.dispensedAt.localeCompare(b.dispensedAt)),
  };
}

const prescriptionsOf = (tenantId: string) =>
  mockMedicationPrescriptions(tenantId).filter((rx) => medicationLines(rx).length > 0);

/** A medication order of the hospital, with its prescription. */
function orderOf(tenantId: string, orderId: string) {
  for (const rx of prescriptionsOf(tenantId)) {
    const order = medicationLines(rx).find((each) => each.id === orderId);
    if (order) return { rx, order };
  }
  return undefined;
}

const nameOf = (drug: Drug) =>
  `${drug.genericName}${drug.strength ? ` ${drug.strength}` : ''}${drug.brandName ? ` (${drug.brandName})` : ''}`;

/** Other medicines in use of the same generic name, form and strength, as `substitutesOf`. */
function substitutesOf(tenantId: string, drugId: string): Drug[] {
  const drug = mockDrug(tenantId, drugId);
  if (!drug || drug.type !== 'medicine') return [];
  const key = (text: string | undefined) => (text ?? '').toLowerCase();
  return mockDrugsOf(tenantId)
    .filter(
      (each) =>
        each.id !== drug.id &&
        each.type === 'medicine' &&
        key(each.genericName) === key(drug.genericName) &&
        each.form === drug.form &&
        key(each.strength) === key(drug.strength),
    )
    .sort((a, b) => key(a.brandName).localeCompare(key(b.brandName)));
}

/** Moves an order on to `to` through each step it has not taken yet. */
function moveTo(order: Order, to: 'in_progress' | 'completed') {
  const steps: Order['status'][] = ['placed', 'accepted', 'in_progress', 'completed'];
  for (const step of steps.slice(steps.indexOf(order.status) + 1, steps.indexOf(to) + 1)) {
    moveMockOrder(order.id, step);
  }
}

export const pharmacyHandlers = [
  http.get('*/api/pharmacy/queue', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const listState = url.searchParams.get('state') ?? 'open';
    const days = Number(url.searchParams.get('days') ?? 7);
    if (!['open', 'done'].includes(listState) || !Number.isInteger(days) || days < 1 || days > 90) {
      return invalid();
    }
    const patientId = url.searchParams.get('patientId');
    const zone = mockTenantTimezone(access.tenantId);
    const today = todayIn(zone);
    const firstDay = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const since = zonedToUtc(firstDay, '00:00', zone);
    const open = listState === 'open';
    const rows = prescriptionsOf(access.tenantId)
      .filter(
        (rx) => rx.prescribedAt >= since && (patientId === null || rx.patientId === patientId),
      )
      .map((rx): PharmacyQueueItem => {
        const lines = medicationLines(rx);
        const patient = mockPatient(access.tenantId, rx.patientId);
        return {
          prescriptionId: rx.id,
          encounterId: rx.encounterId,
          patientId: rx.patientId,
          patientName: patient?.name ?? '',
          patientMrn: patient?.mrn ?? '',
          prescribedAt: rx.prescribedAt,
          prescribedByName: rx.prescribedByName,
          lineCount: lines.length,
          openLineCount: lines.filter((line) => OPEN.includes(line.status)).length,
          startedLineCount: lines.filter((line) =>
            ['in_progress', 'completed'].includes(line.status),
          ).length,
        };
      })
      .filter((row) =>
        open ? row.openLineCount > 0 : row.openLineCount === 0 && row.startedLineCount > 0,
      )
      .sort(
        (a, b) =>
          (open ? 1 : -1) *
          (a.prescribedAt.localeCompare(b.prescribedAt) ||
            a.prescriptionId.localeCompare(b.prescriptionId)),
      );
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
    const cursor = url.searchParams.get('cursor');
    let start = 0;
    if (cursor) {
      const index = rows.findIndex((row) => row.prescriptionId === cursor);
      if (index < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
      start = index + 1;
    }
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    return HttpResponse.json({
      items,
      nextCursor: start + limit < rows.length && last ? last.prescriptionId : null,
      ...(cursor ? {} : { total: rows.length }),
    });
  }),

  http.get('*/api/pharmacy/prescriptions/:prescriptionId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const rx = prescriptionsOf(access.tenantId).find((each) => each.id === params.prescriptionId);
    if (!rx) return error(404, 'prescription_not_found', 'No such prescription');
    return HttpResponse.json(prescriptionView(access.tenantId, rx));
  }),

  http.get('*/api/pharmacy/orders/:orderId/options', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = orderOf(access.tenantId, String(params.orderId));
    if (!found) return orderNotFound();
    const locationId = new URL(request.url).searchParams.get('locationId') ?? '';
    const drugId = found.order.drugId ?? '';
    const prescribed = mockDrug(access.tenantId, drugId);
    const items = [
      ...(prescribed && !prescribed.archived ? [prescribed] : []),
      ...substitutesOf(access.tenantId, drugId),
    ];
    const batches = mockUsableBatches(
      access.tenantId,
      items.map((item) => item.id),
      locationId,
    );
    const view = (drug: Drug): DispensableItem => ({
      drugId: drug.id,
      name: nameOf(drug),
      schedule: drug.schedule,
      controlled: drug.controlled,
      batches: batches
        .filter((batch) => batch.drugId === drug.id)
        .map((batch) => ({
          batchId: batch.batchId,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          onHand: batch.onHand,
          ...(batch.mrpMinor === undefined ? {} : { mrpMinor: String(batch.mrpMinor) }),
        })),
    });
    return HttpResponse.json({
      ...(prescribed && !prescribed.archived ? { prescribed: view(prescribed) } : {}),
      substitutes: substitutesOf(access.tenantId, drugId).map(view),
    });
  }),

  http.post('*/api/pharmacy/dispenses', async ({ request }) => {
    const access = authorizeWrite(request);
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) return invalid('An idempotency key is required');
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) return sent.replay;
    const body = sent.body;
    if (
      !isObject(body) ||
      typeof body.orderId !== 'string' ||
      typeof body.expectedVersion !== 'number' ||
      typeof body.expectedDispensedQuantity !== 'number' ||
      typeof body.locationId !== 'string' ||
      !Array.isArray(body.batches) ||
      body.batches.length < 1 ||
      body.batches.length > 10
    ) {
      return invalid();
    }
    const lines: { batchId: string; quantity: number }[] = [];
    for (const each of body.batches as unknown[]) {
      if (
        !isObject(each) ||
        typeof each.batchId !== 'string' ||
        typeof each.quantity !== 'number' ||
        !Number.isInteger(each.quantity) ||
        each.quantity < 1 ||
        each.quantity > 10_000
      ) {
        return invalid();
      }
      lines.push({ batchId: each.batchId, quantity: each.quantity });
    }
    if (new Set(lines.map((line) => line.batchId)).size !== lines.length) {
      return error(422, 'unknown_batch', 'A batch is given once in a dispense');
    }
    const reason =
      typeof body.substitutionReason === 'string'
        ? body.substitutionReason.replace(/\s+/g, ' ').trim()
        : null;
    const found = orderOf(access.tenantId, body.orderId);
    if (!found) return orderNotFound();
    const { rx, order } = found;
    if (order.status === 'completed' || order.status === 'cancelled') {
      return error(409, 'invalid_transition', 'The order is not dispensed');
    }
    const before = dispensedOf(order.id);
    if (order.version !== body.expectedVersion || before !== body.expectedDispensedQuantity) {
      return error(409, 'conflict', 'It has changed since it was read');
    }
    const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
    if (order.quantity !== undefined && before + quantity > order.quantity) {
      return error(409, 'over_quantity', 'More than the prescribed quantity');
    }
    let item: Drug | undefined;
    if (body.drugId === undefined || body.drugId === order.drugId) {
      if (reason) return invalid('A reason is for a substitute only');
      item = mockDrug(access.tenantId, order.drugId ?? '');
      if (!item || item.archived) return error(409, 'item_archived', 'The medicine was archived');
    } else {
      item = substitutesOf(access.tenantId, order.drugId ?? '').find(
        (each) => each.id === body.drugId,
      );
      if (!item) return error(422, 'not_a_substitute', 'Not a substitute of the medicine');
      if (!reason) return invalid('Say why a substitute is given');
    }
    state.counter += 1;
    const id = `dsp_${state.counter}`;
    const caller = callerOf();
    const taken = mockStockOut(access.tenantId, {
      locationId: body.locationId,
      drugId: item.id,
      sourceId: id,
      actorName: caller.name,
      lines,
    });
    if ('refused' in taken) {
      const status =
        taken.refused === 'unknown_location' || taken.refused === 'unknown_batch' ? 422 : 409;
      return error(status, taken.refused, 'Refused');
    }
    const dispense: Dispense = {
      id,
      orderId: order.id,
      prescriptionId: rx.id,
      encounterId: rx.encounterId,
      patientId: rx.patientId,
      locationId: body.locationId,
      locationName: taken.locationName,
      prescribedDrugId: order.drugId ?? '',
      drugId: item.id,
      itemName: nameOf(item),
      schedule: item.schedule,
      controlled: item.controlled,
      ...(reason ? { substitutionReason: reason } : {}),
      quantity,
      batches: taken.batches.map((batch) => ({ ...batch, returnedQuantity: 0 })),
      returns: [],
      dispensedAt: new Date(Date.now() + state.counter).toISOString(),
      dispensedByName: caller.name,
    };
    state.dispenses.push(dispense);
    const completes = order.quantity !== undefined && before + quantity === order.quantity;
    moveTo(order, completes ? 'completed' : 'in_progress');
    return sent.answer(dispense, 201);
  }),

  http.post('*/api/pharmacy/orders/:orderId/complete', async ({ request, params }) => {
    const access = authorizeWrite(request);
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) return invalid('An idempotency key is required');
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) return sent.replay;
    const body = sent.body;
    if (!isObject(body) || typeof body.expectedVersion !== 'number') return invalid();
    const found = orderOf(access.tenantId, String(params.orderId));
    if (!found) return orderNotFound();
    const { order, rx } = found;
    if (order.status === 'completed' || order.status === 'cancelled') {
      return error(409, 'invalid_transition', 'The order is not dispensed');
    }
    if (order.version !== body.expectedVersion) {
      return error(409, 'conflict', 'It has changed since it was read');
    }
    if (order.status !== 'in_progress' || dispensedOf(order.id) === 0) {
      return error(409, 'invalid_transition', 'Nothing was dispensed against the line');
    }
    moveMockOrder(order.id, 'completed');
    const now = prescriptionsOf(access.tenantId).find((each) => each.id === rx.id) ?? rx;
    return sent.answer(prescriptionView(access.tenantId, now));
  }),

  http.post('*/api/pharmacy/dispenses/:dispenseId/returns', async ({ request, params }) => {
    const read = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in read) return read.denied;
    const access = authorize(request, { permission: RETURN, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) return invalid('An idempotency key is required');
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) return sent.replay;
    const body = sent.body;
    if (
      !isObject(body) ||
      typeof body.reason !== 'string' ||
      body.reason.trim() === '' ||
      !Array.isArray(body.lines) ||
      body.lines.length === 0
    ) {
      return invalid();
    }
    const rx = prescriptionsOf(access.tenantId).find((each) =>
      state.dispenses.some(
        (dispense) => dispense.id === params.dispenseId && dispense.prescriptionId === each.id,
      ),
    );
    // Of the hospital's own prescription only, as the API's row-level security holds it.
    const dispense = rx
      ? state.dispenses.find(
          (each) => each.id === params.dispenseId && each.prescriptionId === rx.id,
        )
      : undefined;
    if (!rx || !dispense) return error(404, 'dispense_not_found', 'No such dispense');
    const lines: { batchId: string; quantity: number; wasted: boolean }[] = [];
    const seen = new Set<string>();
    for (const line of body.lines as unknown[]) {
      if (
        !isObject(line) ||
        typeof line.batchId !== 'string' ||
        typeof line.restockQuantity !== 'number' ||
        typeof line.wasteQuantity !== 'number'
      ) {
        return invalid();
      }
      const given = dispense.batches.find((each) => each.batchId === line.batchId);
      if (!given || seen.has(line.batchId)) {
        return error(422, 'unknown_batch', 'No such batch of the dispense');
      }
      seen.add(line.batchId);
      if (line.restockQuantity + line.wasteQuantity > given.quantity - given.returnedQuantity) {
        return error(409, 'over_return', 'More than was dispensed and not yet returned');
      }
      if (line.restockQuantity > 0) {
        lines.push({ batchId: line.batchId, quantity: line.restockQuantity, wasted: false });
      }
      if (line.wasteQuantity > 0) {
        lines.push({ batchId: line.batchId, quantity: line.wasteQuantity, wasted: true });
      }
    }
    if (lines.length === 0) return invalid('A return brings back at least one unit');
    state.counter += 1;
    const id = `dret_${state.counter}`;
    const caller = callerOf();
    const refused = mockStockIn(access.tenantId, {
      locationId: dispense.locationId,
      source: 'dispense_return',
      sourceId: id,
      actorName: caller.name,
      lines,
    });
    if (refused) {
      return error(refused.refused === 'batch_expired' ? 409 : 422, refused.refused, 'Refused');
    }
    for (const line of lines) {
      const given = dispense.batches.find((each) => each.batchId === line.batchId);
      if (given) given.returnedQuantity += line.quantity;
    }
    dispense.returns.push({
      id,
      reason: body.reason.trim(),
      returnedAt: new Date(Date.now() + state.counter).toISOString(),
      returnedByName: caller.name,
      lines: lines.map((line) => ({
        ...line,
        batchNumber:
          dispense.batches.find((each) => each.batchId === line.batchId)?.batchNumber ?? '',
      })),
    });
    return sent.answer(prescriptionView(access.tenantId, rx), 201);
  }),

  http.post('*/api/pharmacy/dispenses/:dispenseId/print', async ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) return sent.replay;
    const dispense = state.dispenses.find(
      (each) =>
        each.id === params.dispenseId &&
        prescriptionsOf(access.tenantId).some((rx) => rx.id === each.prescriptionId),
    );
    if (!dispense) return error(404, 'dispense_not_found', 'No such dispense');
    state.prints.push({
      tenantId: access.tenantId,
      dispenseId: dispense.id,
      userId: callerOf().id,
    });
    return sent.answer(null, 204);
  }),
];
