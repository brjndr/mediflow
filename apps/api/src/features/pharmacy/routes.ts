import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { medicationOrder, moveMedicationOrder, type MedicationOrder } from '../clinical/index.js';
import { dispensableDrug, substitutesOf, type DispensableDrug } from '../drugs/index.js';
import { stockIn, stockOut, usableBatches } from '../inventory/index.js';
import {
  dispensedOf,
  dispensesOf,
  findDispense,
  findPrescription,
  insertDispense,
  insertDispenseLine,
  insertDispenseReturn,
  insertDispenseReturnLine,
  isUuid,
  linesOf,
  listQueue,
  lockDispense,
  prescriptionOfReturn,
  type DispenseRow,
  type LineRow,
  type QueueRow,
} from './repository.js';
import {
  Dispense,
  DispenseCreate,
  DispenseOptions,
  DispenseOptionsQuery,
  DispenseReturnCreate,
  LineComplete,
  PHARMACY_SCHEMAS,
  PharmacyPrescription,
  PharmacyQueuePage,
  PharmacyQueueQuery,
  QUANTITY_MAX,
  QUEUE_DAYS_DEFAULT,
  REASON_MAX,
  type PharmacyLine,
  type PharmacyQueueItem,
} from './schemas.js';
import { saleRoutes } from './sales-routes.js';
import { SALE_SCHEMAS } from './sales-schemas.js';

export const FEATURE = 'pharmacy';

const READ = 'dispense:read';
const CREATE = 'dispense:create';
const RETURN = 'dispense:return';

const conflict = () => new HttpError(409, 'conflict', 'It has changed since it was read');
const orderNotFound = () => new HttpError(404, 'order_not_found', 'No such order');
const prescriptionNotFound = () =>
  new HttpError(404, 'prescription_not_found', 'No such prescription');
const dispenseNotFound = () => new HttpError(404, 'dispense_not_found', 'No such dispense');

const optional = <Key extends string, Value>(key: Key, value: Value | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const queueItemView = (row: QueueRow): PharmacyQueueItem => ({
  prescriptionId: row.prescription_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  prescribedAt: row.prescribed_at.toISOString(),
  prescribedByName: row.prescribed_by_name,
  lineCount: row.line_count,
  openLineCount: row.open_count,
  startedLineCount: row.started_count,
});

const lineView = (row: LineRow): PharmacyLine => ({
  orderId: row.order_id,
  lineNumber: row.line_number,
  version: row.version,
  status: row.status,
  drugId: row.drug_id,
  itemName: row.item_name,
  dose: row.dose,
  frequency: row.frequency,
  route: row.route,
  ...optional('durationDays', row.duration_days),
  ...optional('quantity', row.quantity),
  ...optional('instructions', row.instructions),
  ...optional('cancelReason', row.cancel_reason),
  dispensedQuantity: row.dispensed_quantity,
});

const dispenseView = (row: DispenseRow): Dispense => ({
  id: row.id,
  orderId: row.order_id,
  prescriptionId: row.prescription_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  locationId: row.location_id,
  locationName: row.location_name,
  prescribedDrugId: row.prescribed_drug_id,
  drugId: row.drug_id,
  itemName: row.item_name,
  schedule: row.schedule,
  controlled: row.controlled,
  ...optional('substitutionReason', row.substitution_reason),
  quantity: row.quantity,
  batches: row.batches,
  returns: row.returns,
  dispensedAt: row.dispensed_at.toISOString(),
  dispensedByName: row.dispensed_by_name,
});

const PrescriptionParams = Type.Object({ prescriptionId: Type.String() });
const OrderParams = Type.Object({ orderId: Type.String() });
const DispenseParams = Type.Object({ dispenseId: Type.String() });

export const pharmacyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of PHARMACY_SCHEMAS) app.addSchema(schema);
  for (const schema of SALE_SCHEMAS) app.addSchema(schema);
  await app.register(saleRoutes);

  /**
   * The pharmacy dispenses the whole hospital's prescriptions, so only the scope `all` reaches
   * anything: a narrower one sees an empty queue and the same 404 as another hospital's record.
   */
  const reaches = (request: FastifyRequest, permission: Permission) =>
    request.access.scope(permission) === 'all';

  /** A write answers with the patient's record, so it needs both permissions at scope `all`. */
  const writes = (request: FastifyRequest) => reaches(request, CREATE) && reaches(request, READ);

  /** The prescription as the pharmacy has it now, every row of it audited as a read. */
  async function prescriptionAnswer(
    request: FastifyRequest,
    prescriptionId: string,
  ): Promise<PharmacyPrescription> {
    const client = request.txClient;
    const row = await findPrescription(client, prescriptionId);
    if (!row) throw prescriptionNotFound();
    const lines = await linesOf(client, row.id);
    const dispenses = await dispensesOf(client, row.id);
    request.audit('read', 'prescription', row.id);
    for (const line of lines) request.audit('read', 'order', line.order_id);
    for (const dispense of dispenses) request.audit('read', 'dispense', dispense.id);
    return {
      prescriptionId: row.id,
      encounterId: row.encounter_id,
      patientId: row.patient_id,
      patientName: row.patient_name,
      patientMrn: row.patient_mrn,
      prescribedAt: row.prescribed_at.toISOString(),
      prescribedByName: row.prescribed_by_name,
      ...optional('advice', row.advice),
      ...optional('replacesId', row.replaces_id),
      ...optional('replacedById', row.replaced_by_id),
      lines: lines.map(lineView),
      dispenses: dispenses.map(dispenseView),
    };
  }

  /** A medication order the caller reaches, locked, at the version sent, still to dispense. */
  async function openOrder(
    request: FastifyRequest,
    orderId: string,
    expectedVersion: number,
  ): Promise<MedicationOrder> {
    if (!writes(request)) throw orderNotFound();
    const order = await medicationOrder(request.txClient, orderId, { forUpdate: true });
    if (!order) throw orderNotFound();
    if (order.status === 'completed' || order.status === 'cancelled') {
      throw new HttpError(409, 'invalid_transition', `A ${order.status} order is not dispensed`);
    }
    if (order.version !== expectedVersion) throw conflict();
    return order;
  }

  /** Moves an open order on to `to` through each step it has not taken yet. */
  async function moveTo(
    request: FastifyRequest,
    order: MedicationOrder,
    to: 'in_progress' | 'completed',
  ): Promise<void> {
    const steps = ['placed', 'accepted', 'in_progress', 'completed'] as const;
    const from = steps.indexOf(order.status as (typeof steps)[number]);
    for (const step of steps.slice(from + 1, steps.indexOf(to) + 1)) {
      if (step !== 'placed') await moveMedicationOrder(request, order.id, step);
    }
  }

  app.get(
    '/pharmacy/queue',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listPharmacyQueue',
        tags: ['pharmacy'],
        description:
          'The pharmacy’s queue (#100): prescriptions with a medication line still to dispense (`open`, the oldest first), or with none left and some dispensed (`done`, the newest first), prescribed within `days` at the hospital (default 7, at most 90), of one patient when asked. Each names the patient (name and MRN), as dispense:read says, and counts its lines. `total` with the first page. Every prescription listed is audited as read. Requires dispense:read with the scope `all` (a narrower one sees nothing) and the pharmacy feature flag. Holds no patient term: a GET.',
        querystring: PharmacyQueueQuery,
        response: { 200: ref(PharmacyQueuePage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query as PharmacyQueueQuery;
      if (!reaches(request, READ)) return { items: [], nextCursor: null, total: 0 };
      const patientId =
        query.patientId === undefined ? null : isUuid(query.patientId) ? query.patientId : false;
      if (patientId === false) return { items: [], nextCursor: null, total: 0 };
      const page = await listQueue(request.txClient, {
        state: query.state ?? 'open',
        days: query.days ?? QUEUE_DAYS_DEFAULT,
        patientId,
        ...optional('cursor', query.cursor),
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'prescription', row.prescription_id);
      return {
        items: page.rows.map(queueItemView),
        nextCursor: page.nextCursor,
        ...optional('total', page.total),
      };
    },
  );

  app.get(
    '/pharmacy/prescriptions/:prescriptionId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getPharmacyPrescription',
        tags: ['pharmacy'],
        description:
          'A prescription as the pharmacy dispenses it: who it is for, its medication lines with the units dispensed against each, and its dispenses with their batches, oldest first. Audited: the prescription, each line and each dispense. Requires dispense:read with the scope `all` and the pharmacy feature flag.',
        params: PrescriptionParams,
        response: { 200: ref(PharmacyPrescription), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      if (!reaches(request, READ)) throw prescriptionNotFound();
      return prescriptionAnswer(request, request.params.prescriptionId);
    },
  );

  app.get(
    '/pharmacy/orders/:orderId/options',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getDispenseOptions',
        tags: ['pharmacy'],
        description:
          'What may be given for a medication line at a place: the prescribed medicine (absent once archived) and its generic substitutes (other medicines in use of the same generic name, form and strength), each with its batches in date that have stock there, nearest expiry first. A place not in use has no batches. Requires dispense:read with the scope `all` and the pharmacy feature flag.',
        params: OrderParams,
        querystring: DispenseOptionsQuery,
        response: { 200: ref(DispenseOptions), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      if (!reaches(request, READ)) throw orderNotFound();
      const client = request.txClient;
      const order = await medicationOrder(client, request.params.orderId);
      if (!order) throw orderNotFound();
      const prescribed = await dispensableDrug(client, order.drugId);
      const substitutes = await substitutesOf(client, order.drugId);
      const items = [...(prescribed ? [prescribed] : []), ...substitutes];
      const batches = await usableBatches(
        client,
        items.map((item) => item.id),
        (request.query as { locationId: string }).locationId,
      );
      const itemView = (item: DispensableDrug) => ({
        drugId: item.id,
        name: item.name,
        schedule: item.schedule,
        controlled: item.controlled,
        batches: batches
          .filter((batch) => batch.drugId === item.id)
          .map((batch) => ({
            batchId: batch.batchId,
            batchNumber: batch.batchNumber,
            expiryDate: batch.expiryDate,
            onHand: batch.onHand,
            ...optional('mrpMinor', batch.mrpMinor),
          })),
      });
      return {
        ...(prescribed ? { prescribed: itemView(prescribed) } : {}),
        substitutes: substitutes.map(itemView),
      };
    },
  );

  /** A repeat of a dispense: the dispense as it is now, audited as a read. */
  async function replayDispense(request: FastifyRequest, reply: FastifyReply) {
    const again =
      request.idempotentId && writes(request)
        ? await findDispense(request.txClient, request.idempotentId)
        : null;
    if (!again) throw dispenseNotFound();
    request.audit('read', 'dispense', again.id);
    return reply.status(201).send(dispenseView(again));
  }

  app.post(
    '/pharmacy/dispenses',
    {
      config: {
        permissions: [CREATE, READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createDispense',
        tags: ['pharmacy'],
        description:
          'Dispenses units of a medication line (#100) from batches at a place, at the order’s version and the units given so far (409 `conflict` when either changed), in full or in part: the units leave stock through the ledger and the order moves in progress, or completed once the prescribed quantity is given. A line with no quantity prescribed stays in progress until completed (`POST /pharmacy/orders/:id/complete`). `drugId` gives a generic substitute instead (the same generic name, form and strength, in use; 422 `not_a_substitute`) with a reason. Refused: an order completed or cancelled (409 `invalid_transition`), more than the prescribed quantity in all (409 `over_quantity`), the prescribed medicine archived (409 `item_archived`), a place not in use (422 `unknown_location`), a batch that is not the item’s (422 `unknown_batch`) or given twice, an expired batch (409 `batch_expired`), more than a batch holds at the place (409 `insufficient_stock`). Emits `pharmacy.dispensed`, `order.completed` when it completes the order, and `stock.low` when the hospital’s stock of the item reaches its reorder level. The Idempotency-Key header is required: a repeat moves no stock and answers with the dispense as it is now. Audited.',
        headers: RequiredIdempotencyHeaders,
        body: ref(DispenseCreate),
        response: { 201: ref(Dispense), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) return replayDispense(request, reply);
      const body = request.body as DispenseCreate;
      const client = request.txClient;
      const actorId = userIdOf(request);
      const batchIds = body.batches.map((line) => line.batchId.toLowerCase());
      if (new Set(batchIds).size !== batchIds.length) {
        throw new HttpError(422, 'unknown_batch', 'A batch is given once in a dispense');
      }
      const reason = tidyOptional(body.substitutionReason, REASON_MAX);
      // The order first, locked: a second dispense of it waits here, then finds a new version.
      const order = await openOrder(request, body.orderId, body.expectedVersion);
      const quantity = body.batches.reduce((sum, line) => sum + line.quantity, 0);
      if (quantity > QUANTITY_MAX) {
        throw new HttpError(400, 'validation_failed', `At most ${QUANTITY_MAX} units at once`);
      }
      const before = await dispensedOf(client, order.id);
      // A line in progress keeps its version from one dispense to the next (the order's state does
      // not change), so what was given so far is what the dispense was made from too.
      if (before !== body.expectedDispensedQuantity) throw conflict();
      if (order.quantity !== null && before + quantity > order.quantity) {
        throw new HttpError(409, 'over_quantity', 'More than the prescribed quantity');
      }
      let item: DispensableDrug | null;
      if (body.drugId === undefined || body.drugId.toLowerCase() === order.drugId) {
        if (reason !== null) {
          throw new HttpError(400, 'validation_failed', 'A reason is for a substitute only');
        }
        item = await dispensableDrug(client, order.drugId);
        if (!item) throw new HttpError(409, 'item_archived', 'The medicine was archived');
      } else {
        const wanted = body.drugId.toLowerCase();
        item =
          (await substitutesOf(client, order.drugId)).find((each) => each.id === wanted) ?? null;
        if (!item) {
          throw new HttpError(422, 'not_a_substitute', 'Not a substitute of the medicine');
        }
        if (reason === null) {
          throw new HttpError(400, 'validation_failed', 'Say why a substitute is given');
        }
      }
      // Stock goes out first, naming the dispense written right after it: the place is checked and
      // locked there, in inventory's lock order after the order.
      const dispenseId = randomUUID();
      const posted = await stockOut(request, {
        locationId: body.locationId,
        drugId: item.id,
        reorderLevel: item.reorderLevel,
        source: 'dispense',
        sourceId: dispenseId,
        reason: 'dispense',
        actorId,
        lines: body.batches.map((line) => ({
          batchId: line.batchId.toLowerCase(),
          quantity: line.quantity,
        })),
      });
      await insertDispense(client, {
        id: dispenseId,
        orderId: order.id,
        prescriptionId: order.prescriptionId,
        encounterId: order.encounterId,
        patientId: order.patientId,
        locationId: body.locationId,
        prescribedDrugId: order.drugId,
        drugId: item.id,
        substitutionReason: reason,
        itemName: item.name,
        schedule: item.schedule,
        controlled: item.controlled,
        quantity,
        dispensedBy: actorId,
      });
      for (const line of posted) {
        await insertDispenseLine(client, { dispenseId, drugId: item.id, ...line });
      }
      request.idempotentId = dispenseId;
      request.audit('create', 'dispense', dispenseId);
      const completes = order.quantity !== null && before + quantity === order.quantity;
      await moveTo(request, order, completes ? 'completed' : 'in_progress');
      await request.emit('pharmacy.dispensed', dispenseId, {
        dispenseId,
        orderId: order.id,
        prescriptionId: order.prescriptionId,
        encounterId: order.encounterId,
        patientId: order.patientId,
        drugId: item.id,
        prescribedDrugId: order.drugId,
        locationId: body.locationId,
        substituted: item.id !== order.drugId,
      });
      const saved = await findDispense(client, dispenseId);
      if (!saved) throw dispenseNotFound();
      return reply.status(201).send(dispenseView(saved));
    },
  );

  app.post(
    '/pharmacy/orders/:orderId/complete',
    {
      config: {
        permissions: [CREATE, READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'completeMedicationOrder',
        tags: ['pharmacy'],
        description:
          'Completes a medication line in progress (some dispensed) at its version (409 `conflict`) when nothing more will be given: the rest of the prescribed quantity, or a line with no quantity prescribed. Refused for a line with nothing dispensed, completed or cancelled (409 `invalid_transition`). Emits `order.completed`. Answers the prescription as it is now. The Idempotency-Key header is required: a repeat changes nothing. Audited.',
        headers: RequiredIdempotencyHeaders,
        params: OrderParams,
        body: ref(LineComplete),
        response: { 200: ref(PharmacyPrescription), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      if (request.replayOf !== null) {
        const again = writes(request)
          ? await medicationOrder(request.txClient, request.params.orderId)
          : null;
        if (!again) throw orderNotFound();
        return prescriptionAnswer(request, again.prescriptionId);
      }
      const body = request.body as LineComplete;
      const order = await openOrder(request, request.params.orderId, body.expectedVersion);
      // In progress with nothing dispensed: moved on by the order route before the pharmacy was
      // switched on. It is dispensed first, never completed with nothing given.
      if (order.status !== 'in_progress' || (await dispensedOf(request.txClient, order.id)) === 0) {
        throw new HttpError(409, 'invalid_transition', 'Nothing was dispensed against the line');
      }
      await moveMedicationOrder(request, order.id, 'completed');
      return prescriptionAnswer(request, order.prescriptionId);
    },
  );

  app.post(
    '/pharmacy/dispenses/:dispenseId/print',
    {
      config: {
        permissions: [READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'printDispenseSlip',
        tags: ['pharmacy'],
        description:
          'Records that a dispense slip is printed (the audit entry `print` of the dispense) and answers 204: the web app makes the page from what it read. A new key per press; a repeat records nothing more. Requires dispense:read with the scope `all` and the pharmacy feature flag.',
        headers: RequiredIdempotencyHeaders,
        params: DispenseParams,
        response: { 204: Type.Null(), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (!reaches(request, READ)) throw dispenseNotFound();
      const dispense = await findDispense(request.txClient, request.params.dispenseId);
      if (!dispense) throw dispenseNotFound();
      if (request.replayOf === null) request.audit('print', 'dispense', dispense.id);
      return reply.status(204).send(null);
    },
  );
  app.post(
    '/pharmacy/dispenses/:dispenseId/returns',
    {
      config: {
        permissions: [RETURN, READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createDispenseReturn',
        tags: ['pharmacy'],
        description:
          'Brings units of a dispense back, with a reason (#104): each batch of the dispense once (422 `unknown_batch` for one not of it or given twice), its units back into stock at the dispense’s place (`restockQuantity`, the ledger’s reason `dispense_return`) or wasted (`wasteQuantity`: an entry in and one out with the reason `wastage`, so stock does not change and the drug register holds them), at least one unit in all (400), never more than was dispensed of the batch less what was returned before (409 `over_return`). An expired batch at the hospital today is never stock again (409 `batch_expired`: waste it); a place no longer in use is 422 `unknown_location`. The prescription line is not reopened. Emits `pharmacy.dispense_returned`. Answers the prescription as it is now. The Idempotency-Key header is required: a repeat moves no stock. Requires dispense:return and dispense:read with the scope `all` and the pharmacy feature flag. Audited.',
        headers: RequiredIdempotencyHeaders,
        params: DispenseParams,
        body: ref(DispenseReturnCreate),
        response: { 201: ref(PharmacyPrescription), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (!reaches(request, RETURN) || !reaches(request, READ)) throw dispenseNotFound();
      if (request.replayOf !== null) {
        const prescriptionId = request.idempotentId
          ? await prescriptionOfReturn(request.txClient, request.idempotentId)
          : null;
        if (!prescriptionId) throw dispenseNotFound();
        return reply.status(201).send(await prescriptionAnswer(request, prescriptionId));
      }
      const body = request.body as DispenseReturnCreate;
      const client = request.txClient;
      const actorId = userIdOf(request);
      const dispenseId = request.params.dispenseId.toLowerCase();
      if (!isUuid(dispenseId)) throw dispenseNotFound();
      const reason = tidyWithin(body.reason, REASON_MAX);
      // Held against another return of the dispense, so two together never return a unit twice.
      await lockDispense(client, dispenseId);
      const dispense = await findDispense(client, dispenseId);
      if (!dispense) throw dispenseNotFound();
      const wanted = body.lines.map((line) => line.batchId.toLowerCase());
      if (new Set(wanted).size !== wanted.length) {
        throw new HttpError(422, 'unknown_batch', 'A batch is given once in a return');
      }
      const lines: { batchId: string; quantity: number; wasted: boolean }[] = [];
      for (const line of body.lines) {
        const given = dispense.batches.find((each) => each.batchId === line.batchId.toLowerCase());
        if (!given) throw new HttpError(422, 'unknown_batch', 'No such batch of the dispense');
        const units = line.restockQuantity + line.wasteQuantity;
        if (units > given.quantity - given.returnedQuantity) {
          throw new HttpError(409, 'over_return', 'More than was dispensed and not yet returned');
        }
        if (line.restockQuantity > 0) {
          lines.push({ batchId: given.batchId, quantity: line.restockQuantity, wasted: false });
        }
        if (line.wasteQuantity > 0) {
          lines.push({ batchId: given.batchId, quantity: line.wasteQuantity, wasted: true });
        }
      }
      if (lines.length === 0) {
        throw new HttpError(400, 'validation_failed', 'A return brings back at least one unit');
      }
      const returnId = randomUUID();
      const entries = await stockIn(request, {
        locationId: dispense.location_id,
        drugId: dispense.drug_id,
        source: 'dispense_return',
        sourceId: returnId,
        reason: 'dispense_return',
        actorId,
        lines,
      });
      await insertDispenseReturn(client, { id: returnId, dispenseId, reason, returnedBy: actorId });
      for (const [index, entry] of entries.entries()) {
        await insertDispenseReturnLine(client, {
          returnId,
          dispenseId,
          batchId: entry.batchId,
          quantity: entry.quantity,
          wasted: lines[index]?.wasted ?? false,
          ledgerEntryId: entry.ledgerEntryId,
          wasteEntryId: entry.wasteEntryId,
        });
      }
      request.idempotentId = returnId;
      request.audit('create', 'dispense_return', returnId);
      await request.emit('pharmacy.dispense_returned', returnId, {
        returnId,
        dispenseId,
        orderId: dispense.order_id,
        encounterId: dispense.encounter_id,
        patientId: dispense.patient_id,
        drugId: dispense.drug_id,
        locationId: dispense.location_id,
      });
      return reply.status(201).send(await prescriptionAnswer(request, dispense.prescription_id));
    },
  );
};
