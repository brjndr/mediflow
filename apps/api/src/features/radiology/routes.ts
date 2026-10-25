import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isEmptyRichText, sanitizeRichText } from '../../core/http/rich-text.js';
import { tidyWithin } from '../../core/http/text.js';
import { imagingOrder, moveImagingOrder, type ImagingOrder } from '../clinical/index.js';
import { isTemplateVersion, placeholdersIn } from '../templates/index.js';
import {
  addendaOf,
  insertAddendum,
  insertReport,
  reportOf,
  signReport,
  updateReport,
  type AddendumRow,
  type ReportRow,
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
  ImagingAddendumCreate,
  ImagingReport,
  ImagingReportDraft,
  ImagingReportSign,
  LINK_LABEL_MAX,
  type ImagingLink,
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
const REPORT_WRITE = 'imagingReport:write';
const REPORT_SIGN = 'imagingReport:sign';

const SLOT_MS = SLOT_MINUTES * 60_000;

const orderNotFound = () => new HttpError(404, 'order_not_found', 'No such imaging order');
const invalid = (message: string) => new HttpError(409, 'invalid_transition', message);
const conflict = () => new HttpError(409, 'conflict', 'The record has changed since it was read');
const reportNotFound = () => new HttpError(404, 'report_not_found', 'The study has no report');
const reportSigned = () => new HttpError(409, 'report_signed', 'A signed report does not change');

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
    patientSex: row.patient_sex,
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
    ...optional('reportStatus', row.report_status),
    ...optional('reportSignedAt', row.report_signed_at && iso(row.report_signed_at)),
    ...optional('reportSignedByName', row.report_signed_at && (row.report_signed_by_name ?? '')),
  };
}

const document = (value: unknown) => sanitizeRichText(value) as unknown as Record<string, unknown>;

/** The links as stored: only what this module wrote, read back defensively. */
function linksOf(value: unknown): ImagingLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link: unknown) => {
    if (typeof link !== 'object' || link === null) return [];
    const { label, url } = link as Record<string, unknown>;
    return typeof label === 'string' && typeof url === 'string' ? [{ label, url }] : [];
  });
}

function reportView(row: ReportRow, addenda: readonly AddendumRow[]): ImagingReport {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    studyId: row.study_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    status: row.status,
    technique: document(row.technique),
    findings: document(row.findings),
    impression: document(row.impression),
    links: linksOf(row.links),
    ...optional('templateId', row.template_id),
    ...optional('templateVersion', row.template_version),
    createdByName: row.created_by_name ?? '',
    createdAt: iso(row.created_at),
    updatedByName: row.updated_by_name ?? '',
    updatedAt: iso(row.updated_at),
    ...optional('signedByName', row.signed_at && (row.signed_by_name ?? '')),
    ...optional('signedAt', row.signed_at && iso(row.signed_at)),
    addenda: addenda.map((addendum) => ({
      id: addendum.id,
      body: document(addendum.body),
      reason: addendum.reason as ImagingReport['addenda'][number]['reason'],
      signedByName: addendum.signed_by_name ?? '',
      signedAt: iso(addendum.signed_at),
    })),
    version: row.version,
  };
}

/** A parameter name that says it carries a secret: a token, a signature, a key, a session. */
const SECRET_PARAMETER = /token|sig|key|auth|pass|secret|credential|session/i;

/** The names of an address's parameters, in its query and in a fragment written as one. */
function parameterNames(url: URL): string[] {
  const fragment = url.hash.slice(1);
  const inFragment = fragment.includes('=')
    ? [...new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).keys()]
    : [];
  return [...url.searchParams.keys(), ...inFragment];
}

/**
 * A link is https with a host, no user name or password and no parameter named as a secret
 * (400 `invalid_link`): a signed report is never changed, so a credential in a link would be
 * kept for ever and shown to every reader.
 */
function cleanLink(link: ImagingLink): ImagingLink {
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    throw new HttpError(400, 'invalid_link', 'A link is not an address');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    parameterNames(url).some((name) => SECRET_PARAMETER.test(name))
  ) {
    throw new HttpError(400, 'invalid_link', 'A link is an https address with no credentials');
  }
  const label = tidyWithin(link.label, LINK_LABEL_MAX);
  if (!label) throw new HttpError(400, 'validation_failed', 'A link has a label');
  return { label, url: url.href };
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
          'Radiology’s worklist (#96): the hospital’s imaging orders not cancelled or completed, at one stage, of one modality and priority when asked. To schedule is stat first, then urgent, then routine, the oldest ordered first within each; scheduled is the soonest slot first; performed the longest waiting first; reported (#97) the newest signed first. Each names the patient (name, MRN and date of birth), the study as ordered, its modality and its study. `total` comes with the first page, except for reported, whose count only grows. Every row read is audited. Requires imagingStudy:read with the scope `all` (a narrower one sees nothing) and the radiology feature flag. Holds no patient term: a GET.',
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

  /** An imaging order the caller reaches with `permission`, its study and its report. */
  async function reportFor(
    request: FastifyRequest<{ Params: { orderId: string } }>,
    permission: Permission,
    { lock }: { lock: boolean },
  ) {
    let order: ImagingOrder | null = null;
    if (lock) order = await orderFor(request, request.params.orderId, permission);
    else if (reaches(request, permission)) {
      order = await imagingOrder(request.txClient, request.params.orderId);
    }
    if (!order) throw orderNotFound();
    const study = await studyOf(request.txClient, order.id, { forUpdate: lock });
    const report = study ? await reportOf(request.txClient, study.id, { forUpdate: lock }) : null;
    return { order, study, report };
  }

  /**
   * Whether the caller may write or sign reports, with the scope `all`: only they read a draft.
   * Read from the policy, as the route that asks declares neither permission.
   */
  async function writesReports(request: FastifyRequest): Promise<boolean> {
    const policy = await request.access.policy();
    return (policy?.permissions ?? []).some(
      (grant) =>
        (grant.permission === REPORT_WRITE || grant.permission === REPORT_SIGN) &&
        grant.scope === 'all',
    );
  }

  /** The report as it is now, with its addenda, audited as `action`. */
  async function sendReport(
    request: FastifyRequest,
    studyId: string,
    action: 'create' | 'update' | 'read',
  ): Promise<ImagingReport> {
    const report = await reportOf(request.txClient, studyId);
    if (!report) throw reportNotFound();
    request.audit(action, 'imaging_report', report.id);
    return reportView(report, await addendaOf(request.txClient, report.id));
  }

  /** A repeat of an idempotency key changes nothing: the report as it is now. */
  async function replay(
    request: FastifyRequest<{ Params: { orderId: string } }>,
    permission: Permission,
  ) {
    const { study } = await reportFor(request, permission, { lock: false });
    if (!study) throw reportNotFound();
    return sendReport(request, study.id, 'read');
  }

  /** The ids an event of a report carries: never its text, a name or a link. */
  const reportEvent = (order: ImagingOrder, report: ReportRow) => ({
    reportId: report.id,
    studyId: report.study_id,
    orderId: order.id,
    encounterId: order.encounterId,
    patientId: order.patientId,
    serviceId: order.serviceId,
  });

  app.get(
    '/radiology/orders/:orderId/report',
    {
      config: { permissions: [STUDY_READ], feature: FEATURE },
      schema: {
        operationId: 'getImagingReport',
        tags: ['radiology'],
        description:
          'The report of an imaging order’s study (#97), with its addenda: a signed one for anyone who reads the worklist, a draft only for whoever may write or sign reports (otherwise 404 `report_not_found`, as with no report), as an unverified lab result is withheld. `order_not_found` for no such order. Requires imagingStudy:read with the scope `all` and the radiology feature flag. Audited.',
        params: OrderParams,
        response: { 200: ref(ImagingReport), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { study, report } = await reportFor(request, STUDY_READ, { lock: false });
      if (!study || !report) throw reportNotFound();
      if (report.status === 'draft' && !(await writesReports(request))) throw reportNotFound();
      return sendReport(request, study.id, 'read');
    },
  );

  const REPEAT =
    ' The Idempotency-Key header is required: a repeat changes nothing and answers with the report as it is now. Audited.';

  app.put(
    '/radiology/orders/:orderId/report',
    {
      config: {
        permissions: [REPORT_WRITE, STUDY_READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'saveImagingReport',
        tags: ['radiology'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Saves the draft report of a performed study (#97), the whole of it: the first save makes it, after that the report’s version is required (409 `conflict`). Anyone who may write reports edits the draft. Refused for a study not performed (409 `invalid_transition`) and once the report is signed (409 `report_signed`). A link is https with no credentials (400 `invalid_link`); a template is an imaging report template of the hospital at that version (422 `template_not_found`). Requires imagingReport:write and imagingStudy:read with the scope `all` and the radiology feature flag.' +
          REPEAT,
        params: OrderParams,
        body: ref(ImagingReportDraft),
        response: { 200: ref(ImagingReport), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      if (request.replayOf !== null) return replay(request, REPORT_WRITE);
      const body = request.body as ImagingReportDraft;
      const { order, study, report } = await reportFor(request, REPORT_WRITE, { lock: true });
      if (report?.status === 'signed') throw reportSigned();
      if (!study?.performed_at || order.status !== 'in_progress') {
        throw invalid('Only a performed study is reported');
      }
      if (report && body.version !== report.version) throw conflict();
      if ((body.templateId === undefined) !== (body.templateVersion === undefined)) {
        throw new HttpError(400, 'validation_failed', 'A template is sent with its version');
      }
      if (body.templateId !== undefined && body.templateVersion !== undefined) {
        // The template the draft already names stays acceptable once archived; a new choice not.
        const kept =
          report?.template_id === body.templateId &&
          report.template_version === body.templateVersion;
        const known = await isTemplateVersion(
          request.txClient,
          { templateId: body.templateId, version: body.templateVersion, kind: 'imaging_report' },
          { archivedToo: kept },
        );
        if (!known) {
          throw new HttpError(422, 'template_not_found', 'No such imaging report template');
        }
      }
      const text = {
        technique: sanitizeRichText(body.technique),
        findings: sanitizeRichText(body.findings),
        impression: sanitizeRichText(body.impression),
        links: body.links.map(cleanLink),
        templateId: body.templateId ?? null,
        templateVersion: body.templateVersion ?? null,
      };
      const userId = userIdOf(request);
      if (report) await updateReport(request.txClient, report.id, text, userId);
      else {
        await insertReport(
          request.txClient,
          {
            id: study.id,
            orderId: order.id,
            encounterId: order.encounterId,
            patientId: order.patientId,
          },
          text,
          userId,
        );
      }
      return sendReport(request, study.id, report ? 'update' : 'create');
    },
  );

  app.post(
    '/radiology/orders/:orderId/report/sign',
    {
      config: {
        permissions: [REPORT_SIGN, STUDY_READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'signImagingReport',
        tags: ['radiology'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Signs the draft report of a study (#97) at the version sent (409 `conflict`): it never changes after, and its order is completed. The findings and the impression are needed (422 `report_incomplete`), and no placeholder of a template may be left unfilled in any part (422 `unfilled_placeholders`). Refused once signed (409 `report_signed`); 404 `report_not_found` with no draft. Requires imagingReport:sign and imagingStudy:read with the scope `all` and the radiology feature flag. Emits `imaging.reported`, and the order’s `order.completed`.' +
          REPEAT,
        params: OrderParams,
        body: ref(ImagingReportSign),
        response: { 200: ref(ImagingReport), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      if (request.replayOf !== null) return replay(request, REPORT_SIGN);
      const body = request.body as ImagingReportSign;
      const { order, study, report } = await reportFor(request, REPORT_SIGN, { lock: true });
      if (!study || !report) throw reportNotFound();
      if (report.status === 'signed') throw reportSigned();
      if (report.version !== body.version) throw conflict();
      if (order.status !== 'in_progress') throw invalid(`A ${order.status} order is not reported`);
      const technique = sanitizeRichText(report.technique);
      const findings = sanitizeRichText(report.findings);
      const impression = sanitizeRichText(report.impression);
      if (isEmptyRichText(findings) || isEmptyRichText(impression)) {
        throw new HttpError(422, 'report_incomplete', 'A report needs findings and an impression');
      }
      if ([technique, findings, impression].some((part) => placeholdersIn(part).length > 0)) {
        throw new HttpError(422, 'unfilled_placeholders', 'A placeholder is left unfilled');
      }
      await signReport(request.txClient, report.id, userIdOf(request));
      await moveImagingOrder(request, order.id, 'completed');
      await request.emit('imaging.reported', report.id, reportEvent(order, report));
      return sendReport(request, study.id, 'update');
    },
  );

  app.post(
    '/radiology/orders/:orderId/report/addenda',
    {
      config: {
        permissions: [REPORT_SIGN, STUDY_READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'addImagingAddendum',
        tags: ['radiology'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds a signed addendum to a signed report (#97): a correction, a later finding, a clarification or a comparison, with its reason from a list. The report itself never changes, and an addendum is never changed or removed. Its text is not empty (400 `validation_failed`). Refused for a draft (409 `report_not_signed`); 404 `report_not_found` with no report. Requires imagingReport:sign and imagingStudy:read with the scope `all` and the radiology feature flag. Emits `imaging.addendum_added`.' +
          REPEAT,
        params: OrderParams,
        body: ref(ImagingAddendumCreate),
        response: { 200: ref(ImagingReport), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      if (request.replayOf !== null) return replay(request, REPORT_SIGN);
      const body = request.body as ImagingAddendumCreate;
      const { order, study, report } = await reportFor(request, REPORT_SIGN, { lock: true });
      if (!study || !report) throw reportNotFound();
      if (report.status !== 'signed') {
        throw new HttpError(409, 'report_not_signed', 'An addendum is added to a signed report');
      }
      const text = sanitizeRichText(body.body);
      if (isEmptyRichText(text)) {
        throw new HttpError(400, 'validation_failed', 'body: the addendum is empty');
      }
      const id = await insertAddendum(
        request.txClient,
        report.id,
        text,
        body.reason,
        userIdOf(request),
      );
      await request.emit('imaging.addendum_added', id, {
        addendumId: id,
        ...reportEvent(order, report),
      });
      return sendReport(request, study.id, 'update');
    },
  );
};
