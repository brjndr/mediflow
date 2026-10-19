import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { prescribableDrug } from '../drugs/index.js';
import { orderableLabTest } from '../lab-tests/index.js';
import { orderableService } from '../services/index.js';
import {
  encounterFor,
  FEATURE,
  invalid,
  orderEvent,
  orderView,
  prescriptionView,
  uniqueRefusal,
  userIdOf,
} from './http.js';
import {
  cancelOpenLines,
  findOrder,
  findPrescription,
  insertOrder,
  insertPrescription,
  listOrders,
  listPrescriptions,
  ordersOfPrescriptions,
  setOrderStatus,
  type NewOrder,
  type OrderRow,
} from './repository.js';
import {
  ADVICE_MAX,
  DOSE_MAX,
  EncounterParams,
  INSTRUCTIONS_MAX,
  Order,
  OrderCancel,
  OrderCreate,
  OrderListQuery,
  OrderPage,
  OrderParams,
  OrderStatusChange,
  PageQuery,
  Prescription,
  PrescriptionCreate,
  PrescriptionPage,
  PrescriptionParams,
  REASON_MAX,
  type OrderStatusValue,
  type OrderTypeValue,
} from './schemas.js';

const ORDER_READ = 'order:read';
const ORDER_CREATE = 'order:create';
const ORDER_UPDATE = 'order:update';
const ORDER_CANCEL = 'order:cancel';
const PRESCRIPTION_READ = 'prescription:read';
const PRESCRIPTION_CREATE = 'prescription:create';

const orderNotFound = () => new HttpError(404, 'order_not_found', 'No such order');
const prescriptionNotFound = () =>
  new HttpError(404, 'prescription_not_found', 'No such prescription');

/** The one step an order may move on to from each status. Cancelling has its own route. */
const NEXT: Partial<Record<OrderStatusValue, OrderStatusValue>> = {
  placed: 'accepted',
  accepted: 'in_progress',
  in_progress: 'completed',
};

const SCOPE =
  ' The encounter decides who reaches it: one of another hospital, or outside the scope the caller holds the route’s permission with, is 404 as one that does not exist.';

export const orderRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** A record of an encounter the caller reaches with `permission`, else the route's 404. */
  async function reached<Row extends { encounter_id: string }>(
    request: FastifyRequest,
    row: Row | null,
    permission: Permission,
    notFound: () => HttpError,
  ): Promise<Row> {
    if (!row) throw notFound();
    try {
      await encounterFor(request, row.encounter_id, permission);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'encounter_not_found') throw notFound();
      throw error;
    }
    return row;
  }

  /**
   * An order in an encounter the caller reaches. `forUpdate` locks it only once the scope is
   * checked, so a caller outside it cannot hold another's order locked.
   */
  const orderFor = async (
    request: FastifyRequest,
    id: string,
    permission: Permission,
    { forUpdate = false }: { forUpdate?: boolean } = {},
  ) => {
    const row = await reached(
      request,
      await findOrder(request.txClient, id),
      permission,
      orderNotFound,
    );
    if (!forUpdate) return row;
    const locked = await findOrder(request.txClient, row.id, { forUpdate: true });
    if (!locked) throw orderNotFound();
    return locked;
  };

  // ----- Orders --------------------------------------------------------------------------------

  app.get(
    '/encounters/:encounterId/orders',
    {
      config: { permissions: [ORDER_READ], feature: FEATURE },
      schema: {
        operationId: 'listOrders',
        tags: ['clinical'],
        description:
          'The encounter’s orders of every type, or of one, oldest first, cancelled ones included. Medication orders are the lines of its prescriptions. Requires order:read and the clinical feature flag. Every order of a page is audited.' +
          SCOPE,
        params: EncounterParams,
        querystring: OrderListQuery,
        response: { 200: ref(OrderPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const encounter = await encounterFor(request, request.params.encounterId, ORDER_READ);
      const { type, cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listOrders(request.txClient, encounter.id, {
        ...(type === undefined ? {} : { type: type as OrderTypeValue }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'order', row.id);
      return {
        items: page.rows.map(orderView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/encounters/:encounterId/orders',
    {
      config: {
        permissions: [ORDER_CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'placeOrder',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Places one order in an open encounter (409 `encounter_not_open` otherwise): `lab` with a labTestId (422 `unknown_lab_test` for one that is not the hospital’s or is archived), `imaging` or `procedure` with a serviceId of that category (422 `unknown_service`), or `diet` with instructions and no catalog id. Any other id, or a missing one, is 400. Medication is prescribed, not ordered here. The item’s code and name are kept as they read now. The lab, radiology and other modules act on it from the event, never from a call. The Idempotency-Key header is required: a repeat places nothing and answers with the order as it is now. Requires order:create and the clinical feature flag. Audited, and emits `order.placed` through the outbox (ids, the type and the priority).' +
          SCOPE,
        params: EncounterParams,
        body: ref(OrderCreate),
        response: { 201: ref(Order), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const placed = request.idempotentId
          ? await orderFor(request, request.idempotentId, ORDER_CREATE)
          : null;
        if (!placed) throw orderNotFound();
        request.audit('read', 'order', placed.id);
        return reply.status(201).send(orderView(placed));
      }
      const body = request.body as OrderCreate;
      const instructions = tidyLinesOptional(body.instructions, INSTRUCTIONS_MAX);
      const wants = body.type === 'lab' ? 'lab' : body.type === 'diet' ? 'none' : 'service';
      if ((body.labTestId !== undefined) !== (wants === 'lab')) {
        throw invalid(`A ${body.type} order ${wants === 'lab' ? 'needs' : 'takes no'} labTestId`);
      }
      if ((body.serviceId !== undefined) !== (wants === 'service')) {
        throw invalid(
          `A ${body.type} order ${wants === 'service' ? 'needs' : 'takes no'} serviceId`,
        );
      }
      if (body.type === 'diet' && instructions === null) {
        throw invalid('A diet order is its instructions');
      }
      const encounter = await encounterFor(request, request.params.encounterId, ORDER_CREATE, {
        open: true,
      });

      const order: NewOrder = {
        encounterId: encounter.id,
        patientId: encounter.patient_id,
        type: body.type,
        itemCode: null,
        itemName: null,
        priority: body.priority ?? 'routine',
        instructions,
      };
      if (body.type === 'lab' && body.labTestId !== undefined) {
        const test = await orderableLabTest(request.txClient, body.labTestId);
        if (!test) throw new HttpError(422, 'unknown_lab_test', 'No such lab test');
        Object.assign(order, { labTestId: test.id, itemCode: test.code, itemName: test.name });
      } else if (
        (body.type === 'imaging' || body.type === 'procedure') &&
        body.serviceId !== undefined
      ) {
        const service = await orderableService(request.txClient, body.serviceId, body.type);
        if (!service) throw new HttpError(422, 'unknown_service', `No such ${body.type} service`);
        Object.assign(order, {
          serviceId: service.id,
          itemCode: service.code,
          itemName: service.name,
        });
      }

      const id = await insertOrder(request.txClient, order, userIdOf(request));
      request.idempotentId = id;
      request.audit('create', 'order', id);
      const placed = await findOrder(request.txClient, id);
      if (!placed) throw new Error('order was not placed');
      await request.emit('order.placed', id, orderEvent(placed));
      return reply.status(201).send(orderView(placed));
    },
  );

  app.get(
    '/orders/:orderId',
    {
      config: { permissions: [ORDER_READ], feature: FEATURE },
      schema: {
        operationId: 'getOrder',
        tags: ['clinical'],
        description:
          'One order, of any type. Requires order:read and the clinical feature flag. Audited.' +
          SCOPE,
        params: OrderParams,
        response: { 200: ref(Order), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await orderFor(request, request.params.orderId, ORDER_READ);
      request.audit('read', 'order', row.id);
      return orderView(row);
    },
  );

  /**
   * The shape both changes of an order share: a repeat answers with the order as it is now;
   * otherwise the order is locked, found in an encounter the caller reaches, at the version the
   * change was made from, and `change` does the rest.
   */
  async function changeOrder(
    request: FastifyRequest<{ Params: { orderId: string } }>,
    reply: FastifyReply,
    permission: Permission,
    version: number,
    change: (row: OrderRow) => Promise<void>,
  ) {
    const id = request.params.orderId;
    if (request.replayOf === null) {
      const row = await orderFor(request, id, permission, { forUpdate: true });
      if (row.version !== version) {
        throw new HttpError(409, 'conflict', 'The order has changed since it was read');
      }
      await change(row);
      request.audit('update', 'order', row.id);
    }
    const now = await orderFor(request, id, permission);
    if (request.replayOf !== null) request.audit('read', 'order', now.id);
    return reply.status(200).send(orderView(now));
  }

  const CHANGE =
    ' The `version` must be the current one, or 409 `conflict`. Allowed after the encounter closed, as results arrive later. The Idempotency-Key header is required: a repeat changes nothing and answers with the order as it is now. Audited.';

  app.post(
    '/orders/:orderId/status',
    {
      config: {
        permissions: [ORDER_UPDATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'advanceOrder',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Moves an order on by one step: placed -> accepted -> in_progress -> completed. Any other move, and any move of a completed or cancelled order, is 409 `invalid_transition` (the database refuses it too). Completing emits `order.completed` through the outbox. Requires order:update and the clinical feature flag.' +
          CHANGE +
          SCOPE,
        params: OrderParams,
        body: ref(OrderStatusChange),
        response: { 200: ref(Order), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as OrderStatusChange;
      return changeOrder(request, reply, ORDER_UPDATE, body.version, async (row) => {
        if (NEXT[row.status] !== body.status) {
          throw new HttpError(
            409,
            'invalid_transition',
            `A ${row.status} order does not become ${body.status}`,
          );
        }
        await setOrderStatus(request.txClient, row.id, body.status, userIdOf(request));
        if (body.status === 'completed') {
          await request.emit('order.completed', row.id, orderEvent(row));
        }
      });
    },
  );

  app.post(
    '/orders/:orderId/cancel',
    {
      config: {
        permissions: [ORDER_CANCEL],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'cancelOrder',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Cancels an order that has not started (placed or accepted), with a reason; one in progress, completed or cancelled is 409 `invalid_transition`. A medication order is a line of its prescription, which stays as written. Emits `order.cancelled` through the outbox. Requires order:cancel and the clinical feature flag.' +
          CHANGE +
          SCOPE,
        params: OrderParams,
        body: ref(OrderCancel),
        response: { 200: ref(Order), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as OrderCancel;
      const reason = tidyWithin(body.reason, REASON_MAX);
      if (reason === '') throw invalid('A reason is needed');
      return changeOrder(request, reply, ORDER_CANCEL, body.version, async (row) => {
        if (row.status !== 'placed' && row.status !== 'accepted') {
          throw new HttpError(409, 'invalid_transition', `A ${row.status} order is not cancelled`);
        }
        await setOrderStatus(request.txClient, row.id, 'cancelled', userIdOf(request), reason);
        await request.emit('order.cancelled', row.id, orderEvent(row));
      });
    },
  );

  // ----- Prescriptions -------------------------------------------------------------------------

  const prescriptionFor = async (request: FastifyRequest, id: string, permission: Permission) => {
    const row = await reached(
      request,
      await findPrescription(request.txClient, id),
      permission,
      prescriptionNotFound,
    );
    return prescriptionView(row, await ordersOfPrescriptions(request.txClient, [row.id]));
  };

  app.get(
    '/encounters/:encounterId/prescriptions',
    {
      config: { permissions: [PRESCRIPTION_READ], feature: FEATURE },
      schema: {
        operationId: 'listPrescriptions',
        tags: ['clinical'],
        description:
          'The encounter’s prescriptions with their lines, oldest first, replaced ones included (each names the one that replaces it). Requires prescription:read and the clinical feature flag. Every prescription of a page is audited.' +
          SCOPE,
        params: EncounterParams,
        querystring: PageQuery,
        response: { 200: ref(PrescriptionPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const encounter = await encounterFor(request, request.params.encounterId, PRESCRIPTION_READ);
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listPrescriptions(request.txClient, encounter.id, {
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      const lines = await ordersOfPrescriptions(
        request.txClient,
        page.rows.map((row) => row.id),
      );
      for (const row of page.rows) request.audit('read', 'prescription', row.id);
      // The lines are orders, read here as much as through the order routes.
      for (const order of lines) request.audit('read', 'order', order.id);
      return {
        items: page.rows.map((row) => prescriptionView(row, lines)),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/encounters/:encounterId/prescriptions',
    {
      config: {
        permissions: [PRESCRIPTION_CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'writePrescription',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Writes a prescription in an open encounter (409 `encounter_not_open` otherwise): 1 to 30 lines, each a medicine of the catalog that is not archived (422 `unknown_drug`) with its dose, route and frequency, and each placed as a medication order. A prescription never changes. To revise one, write a new one with replacesId (a prescription of the same encounter, 422 `unknown_prescription` otherwise) and a reason (400 without one, or with one and no replacesId): its lines not yet started are cancelled, and those in progress or completed stay. A prescription is replaced once (409 `already_replaced`, decided by a unique index). The drug’s name is kept as it reads now. The Idempotency-Key header is required: a repeat writes nothing and answers with the prescription as it is now. Requires prescription:create and the clinical feature flag. Audited (the prescription and each order), and emits `order.placed` for each line and `order.cancelled` for each line it cancels, through the outbox.' +
          SCOPE,
        params: EncounterParams,
        body: ref(PrescriptionCreate),
        response: { 201: ref(Prescription), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const written = request.idempotentId
          ? await prescriptionFor(request, request.idempotentId, PRESCRIPTION_CREATE)
          : null;
        if (!written) throw prescriptionNotFound();
        request.audit('read', 'prescription', written.id);
        for (const order of written.lines) request.audit('read', 'order', order.id);
        return reply.status(201).send(written);
      }
      const userId = userIdOf(request);
      const body = request.body as PrescriptionCreate;
      const advice = tidyLinesOptional(body.advice, ADVICE_MAX);
      const replaceReason =
        body.replaceReason === undefined ? null : tidyWithin(body.replaceReason, REASON_MAX);
      if (replaceReason === '') throw invalid('A reason is needed');
      if ((body.replacesId === undefined) !== (replaceReason === null)) {
        throw invalid('A replacement and its reason go together');
      }
      const lines = body.lines.map((line) => {
        const dose = tidyWithin(line.dose, DOSE_MAX);
        const frequency = tidyWithin(line.frequency, DOSE_MAX);
        if (dose === '' || frequency === '') throw invalid('A line needs a dose and a frequency');
        return {
          ...line,
          dose,
          frequency,
          instructions: tidyLinesOptional(line.instructions, INSTRUCTIONS_MAX),
        };
      });
      const encounter = await encounterFor(
        request,
        request.params.encounterId,
        PRESCRIPTION_CREATE,
        { open: true },
      );

      if (body.replacesId !== undefined) {
        const replaced = await findPrescription(request.txClient, body.replacesId);
        if (!replaced || replaced.encounter_id !== encounter.id) {
          throw new HttpError(422, 'unknown_prescription', 'No such prescription here');
        }
        if (replaced.replaced_by_id !== null) {
          throw new HttpError(409, 'already_replaced', 'The prescription is already replaced');
        }
      }

      const drugs = [];
      for (const line of lines) {
        const drug = await prescribableDrug(request.txClient, line.drugId);
        if (!drug) throw new HttpError(422, 'unknown_drug', 'No such medicine');
        drugs.push(drug);
      }

      let id: string;
      try {
        id = await insertPrescription(
          request.txClient,
          {
            encounterId: encounter.id,
            patientId: encounter.patient_id,
            advice,
            replacesId: body.replacesId ?? null,
            replaceReason,
          },
          userId,
        );
      } catch (error) {
        throw uniqueRefusal(error, {
          prescriptions_replaced_once: new HttpError(
            409,
            'already_replaced',
            'The prescription is already replaced',
          ),
        });
      }
      request.idempotentId = id;
      request.audit('create', 'prescription', id);

      if (body.replacesId !== undefined && replaceReason !== null) {
        const cancelledLines = await cancelOpenLines(
          request.txClient,
          body.replacesId,
          userId,
          replaceReason,
        );
        for (const cancelled of cancelledLines) {
          request.audit('update', 'order', cancelled.id);
          await request.emit('order.cancelled', cancelled.id, orderEvent(cancelled));
        }
      }
      for (const [index, line] of lines.entries()) {
        const drug = drugs[index];
        if (!drug) continue;
        const orderId = await insertOrder(
          request.txClient,
          {
            encounterId: encounter.id,
            patientId: encounter.patient_id,
            type: 'medication',
            drugId: drug.id,
            prescriptionId: id,
            lineNumber: index + 1,
            itemCode: null,
            itemName: drug.name,
            priority: 'routine',
            instructions: line.instructions,
            dose: line.dose,
            route: line.route,
            frequency: line.frequency,
            ...(line.durationDays === undefined ? {} : { durationDays: line.durationDays }),
            ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
          },
          userId,
        );
        request.audit('create', 'order', orderId);
        const placed = await findOrder(request.txClient, orderId);
        if (!placed) throw new Error('order was not placed');
        await request.emit('order.placed', orderId, orderEvent(placed));
      }
      const written = await findPrescription(request.txClient, id);
      if (!written) throw new Error('prescription was not written');
      return reply
        .status(201)
        .send(prescriptionView(written, await ordersOfPrescriptions(request.txClient, [id])));
    },
  );

  app.get(
    '/prescriptions/:prescriptionId',
    {
      config: { permissions: [PRESCRIPTION_READ], feature: FEATURE },
      schema: {
        operationId: 'getPrescription',
        tags: ['clinical'],
        description:
          'One prescription with its lines as they are now. Requires prescription:read and the clinical feature flag. Audited.' +
          SCOPE,
        params: PrescriptionParams,
        response: { 200: ref(Prescription), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const written = await prescriptionFor(
        request,
        request.params.prescriptionId,
        PRESCRIPTION_READ,
      );
      request.audit('read', 'prescription', written.id);
      for (const order of written.lines) request.audit('read', 'order', order.id);
      return written;
    },
  );
};
