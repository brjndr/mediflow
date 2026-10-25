import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { imagingOrder, moveImagingOrder, type ImagingOrder } from '../clinical/index.js';
import {
  insertStudy,
  listWorklist,
  modalityOfService,
  performStudy,
  scheduleStudy,
  scheduleWindowEnd,
  studiesByIds,
  studyOf,
  type StudyRow,
  type WorkItemRow,
} from './repository.js';
import {
  ImagingSchedule,
  ImagingStudy,
  ImagingStudyChange,
  ImagingWorkItemPage,
  OrderParams,
  RADIOLOGY_SCHEMAS,
  SCHEDULE_DAYS_AHEAD,
  SLOT_MINUTES,
  WorklistQuery,
  type ImagingWorkItem,
} from './schemas.js';

export const FEATURE = 'radiology';

const STUDY_READ = 'imagingStudy:read';
const STUDY_SCHEDULE = 'imagingStudy:schedule';
const STUDY_PERFORM = 'imagingStudy:perform';

const SLOT_MS = SLOT_MINUTES * 60_000;

const orderNotFound = () => new HttpError(404, 'order_not_found', 'No such imaging order');
const invalid = (message: string) => new HttpError(409, 'invalid_transition', message);
const conflict = () => new HttpError(409, 'conflict', 'The study has changed since it was read');

const iso = (date: Date) => date.toISOString();
const optional = <Key extends string, Value>(key: Key, value: Value | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

function studyView(row: StudyRow): ImagingStudy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    modality: row.modality,
    ...optional('scheduledAt', row.scheduled_at && iso(row.scheduled_at)),
    ...optional('scheduledByName', row.scheduled_at && (row.scheduled_by_name ?? '')),
    ...optional('performedAt', row.performed_at && iso(row.performed_at)),
    ...optional('performedByName', row.performed_at && (row.performed_by_name ?? '')),
    version: row.version,
  };
}

function workItemView(row: WorkItemRow, study: StudyRow | undefined): ImagingWorkItem {
  return {
    orderId: row.order_id,
    tenantId: row.tenant_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientMrn: row.patient_mrn,
    patientDob: row.patient_dob,
    serviceId: row.service_id,
    ...optional('itemCode', row.item_code),
    itemName: row.item_name,
    modality: row.modality,
    priority: row.priority,
    ...optional('instructions', row.instructions),
    placedAt: iso(row.placed_at),
    orderedByName: row.ordered_by_name,
    orderStatus: row.order_status,
    stage: row.stage,
    ...(study ? { study: studyView(study) } : {}),
  };
}

/** A slot is on a 15-minute step (422 `invalid_slot`). */
function slotOf(scheduledAt: string): Date {
  const at = new Date(scheduledAt);
  if (Number.isNaN(at.getTime()) || at.getTime() % SLOT_MS !== 0) {
    throw new HttpError(422, 'invalid_slot', `A study starts on a ${SLOT_MINUTES}-minute step`);
  }
  return at;
}

/**
 * A slot from the start of the current step, so a study may be booked for the step under way,
 * to the end of the 90th day ahead at the hospital, as the form offers (422 `outside_window`).
 */
async function checkWindow(request: FastifyRequest, at: Date): Promise<void> {
  const now = Date.now();
  const end = await scheduleWindowEnd(request.txClient, SCHEDULE_DAYS_AHEAD);
  if (at.getTime() < now - (now % SLOT_MS) || at.getTime() >= end.getTime()) {
    throw new HttpError(
      422,
      'outside_window',
      `A study is scheduled from now to ${SCHEDULE_DAYS_AHEAD} days ahead`,
    );
  }
}

export const radiologyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of RADIOLOGY_SCHEMAS) app.addSchema(schema);

  /**
   * Radiology works the whole hospital's orders, so only the scope `all` reaches anything: a
   * narrower one sees an empty worklist and the same 404 as another hospital's record.
   */
  const reaches = (request: FastifyRequest, permission: Permission) =>
    request.access.scope(permission) === 'all';

  /** An imaging order the caller reaches with `permission`, locked, else 404. */
  async function orderFor(
    request: FastifyRequest,
    id: string,
    permission: Permission,
  ): Promise<ImagingOrder> {
    if (!reaches(request, permission)) throw orderNotFound();
    const order = await imagingOrder(request.txClient, id, { forUpdate: true });
    if (!order) throw orderNotFound();
    return order;
  }

  /**
   * A change of an order's study: the order locked first, then its study, as every change of
   * radiology does, so it takes its turn with the doctor cancelling the order. A repeat of the
   * idempotency key changes nothing and answers with the study as it is now.
   */
  async function changeStudy(
    request: FastifyRequest<{ Params: { orderId: string } }>,
    reply: FastifyReply,
    permission: Permission,
    change: (order: ImagingOrder, study: StudyRow | null) => Promise<'create' | 'update' | null>,
  ) {
    const { orderId } = request.params;
    if (request.replayOf !== null) {
      const again = reaches(request, permission) ? await studyOf(request.txClient, orderId) : null;
      if (!again) throw orderNotFound();
      request.audit('read', 'imaging_study', again.id);
      return reply.status(200).send(studyView(again));
    }
    const order = await orderFor(request, orderId, permission);
    const study = await studyOf(request.txClient, order.id, { forUpdate: true });
    const action = await change(order, study);
    const now = await studyOf(request.txClient, order.id);
    if (!now) throw orderNotFound();
    request.audit(action ?? 'read', 'imaging_study', now.id);
    return reply.status(200).send(studyView(now));
  }

  /** The ids an event of a study carries: never a time, a name or an instruction. */
  const studyEvent = (order: ImagingOrder, study: StudyRow) => ({
    studyId: study.id,
    orderId: order.id,
    encounterId: order.encounterId,
    patientId: order.patientId,
    serviceId: order.serviceId,
    modality: study.modality,
  });

  app.get(
    '/radiology/worklist',
    {
      config: { permissions: [STUDY_READ], feature: FEATURE },
      schema: {
        operationId: 'listImagingWorklist',
        tags: ['radiology'],
        description:
          'Radiology’s worklist (#96): the hospital’s imaging orders not cancelled or completed, at one stage, of one modality and priority when asked. To schedule is stat first, then urgent, then routine, the oldest ordered first within each; scheduled is the soonest slot first; performed the longest waiting first. Each names the patient (name, MRN and date of birth), the study as ordered, its modality and its study. `total` comes with the first page. Every row read is audited. Requires imagingStudy:read with the scope `all` (a narrower one sees nothing) and the radiology feature flag. Holds no patient term: a GET.',
        querystring: WorklistQuery,
        response: { 200: ref(ImagingWorkItemPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query as WorklistQuery;
      if (!reaches(request, STUDY_READ)) return { items: [], nextCursor: null, total: 0 };
      const page = await listWorklist(request.txClient, {
        stage: query.stage ?? 'to_schedule',
        ...optional('modality', query.modality),
        ...optional('priority', query.priority),
        ...optional('cursor', query.cursor),
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      const studies = await studiesByIds(
        request.txClient,
        page.rows.flatMap((row) => (row.study_id ? [row.study_id] : [])),
      );
      for (const row of page.rows) request.audit('read', 'order', row.order_id);
      for (const id of studies.keys()) request.audit('read', 'imaging_study', id);
      return {
        items: page.rows.map((row) =>
          workItemView(row, row.study_id ? studies.get(row.study_id) : undefined),
        ),
        nextCursor: page.nextCursor,
        ...optional('total', page.total),
      };
    },
  );

  const CHANGE =
    ' The Idempotency-Key header is required: a repeat changes nothing and answers with the study as it is now. Audited.';

  app.post(
    '/radiology/orders/:orderId/schedule',
    {
      config: {
        permissions: [STUDY_SCHEDULE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'scheduleImagingStudy',
        tags: ['radiology'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Schedules the study of an imaging order for a slot, or moves it to another (#96). The first time makes the study, with the modality of its service as it is now, and accepts the order if it was only placed; after that the study’s version is required (409 `conflict`). Refused once the study is performed, and for an order cancelled, completed or moved in progress (409 `invalid_transition`). Requires imagingStudy:schedule and the radiology feature flag. Emits `imaging.scheduled`.' +
          CHANGE,
        params: OrderParams,
        body: ref(ImagingSchedule),
        response: { 200: ref(ImagingStudy), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as ImagingSchedule;
      return changeStudy(request, reply, STUDY_SCHEDULE, async (order, study) => {
        if (order.status !== 'placed' && order.status !== 'accepted') {
          throw invalid(`A ${order.status} order is not scheduled`);
        }
        if (study && body.version !== study.version) throw conflict();
        if (study?.performed_at) throw invalid('A performed study is not scheduled');
        const at = slotOf(body.scheduledAt);
        const scheduledAt = iso(at);
        // The slot it already has changes nothing, even once that slot has begun.
        if (study && study.scheduled_at && iso(study.scheduled_at) === scheduledAt) return null;
        await checkWindow(request, at);
        const userId = userIdOf(request);
        let action: 'create' | 'update' = 'update';
        if (study) {
          await scheduleStudy(request.txClient, study.id, scheduledAt, userId);
        } else {
          await insertStudy(
            request.txClient,
            {
              orderId: order.id,
              encounterId: order.encounterId,
              patientId: order.patientId,
              serviceId: order.serviceId,
              modality: await modalityOfService(request.txClient, order.serviceId),
              scheduledAt,
            },
            userId,
          );
          action = 'create';
        }
        if (order.status === 'placed') await moveImagingOrder(request, order.id, 'accepted');
        const saved = await studyOf(request.txClient, order.id);
        if (!saved) throw orderNotFound();
        await request.emit('imaging.scheduled', saved.id, studyEvent(order, saved));
        return action;
      });
    },
  );

  app.post(
    '/radiology/orders/:orderId/unschedule',
    {
      config: {
        permissions: [STUDY_SCHEDULE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'unscheduleImagingStudy',
        tags: ['radiology'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Takes a scheduled study off its slot (#96), at the version sent (409 `conflict`), so it is to schedule again; the order stays accepted. Refused for a study not scheduled or performed, and for an order cancelled or completed (409 `invalid_transition`); an order with no study is 404. Requires imagingStudy:schedule and the radiology feature flag. Emits `imaging.unscheduled`.' +
          CHANGE,
        params: OrderParams,
        body: ref(ImagingStudyChange),
        response: { 200: ref(ImagingStudy), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as ImagingStudyChange;
      return changeStudy(request, reply, STUDY_SCHEDULE, async (order, study) => {
        if (!study) throw orderNotFound();
        if (study.version !== body.version) throw conflict();
        if (order.status !== 'accepted' || study.performed_at || !study.scheduled_at) {
          throw invalid('Only a scheduled study is unscheduled');
        }
        await scheduleStudy(request.txClient, study.id, null, userIdOf(request));
        await request.emit('imaging.unscheduled', study.id, studyEvent(order, study));
        return 'update';
      });
    },
  );

  app.post(
    '/radiology/orders/:orderId/perform',
    {
      config: {
        permissions: [STUDY_PERFORM],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'performImagingStudy',
        tags: ['radiology'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that a scheduled study was performed (#96), at the version sent (409 `conflict`), and moves its order in progress: it then waits for its report. Refused for a study not scheduled or already performed, and for an order cancelled or completed (409 `invalid_transition`); an order with no study is 404. Requires imagingStudy:perform and the radiology feature flag. Emits `imaging.performed`.' +
          CHANGE,
        params: OrderParams,
        body: ref(ImagingStudyChange),
        response: { 200: ref(ImagingStudy), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as ImagingStudyChange;
      return changeStudy(request, reply, STUDY_PERFORM, async (order, study) => {
        if (!study) throw orderNotFound();
        if (study.version !== body.version) throw conflict();
        if (order.status !== 'accepted' || study.performed_at || !study.scheduled_at) {
          throw invalid('Only a scheduled study is performed');
        }
        await performStudy(request.txClient, study.id, userIdOf(request));
        await moveImagingOrder(request, order.id, 'in_progress');
        await request.emit('imaging.performed', study.id, studyEvent(order, study));
        return 'update';
      });
    },
  );
};
