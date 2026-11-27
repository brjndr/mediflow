import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { hasAdmissionFrom } from '../admissions/index.js';
import { hasStandingBilling } from '../billing/index.js';
import {
  cancelPaperVisit,
  closePaperVisit,
  findPaperVisit,
  findPaperVisitOfToken,
  isUnwrittenVisit,
  openPaperVisit,
  type PaperVisitRecord,
} from '../clinical/index.js';
import { hasAmbulanceTripOn } from '../operations/index.js';
import { patientInScope } from '../patients/index.js';
import { todaysToken, tokenNumberOf } from '../queue/index.js';
import { hasSurgeryOn } from '../theatre/index.js';
import {
  PaperEncounterParams,
  PaperSheetParams,
  PaperTokenParams,
  PaperVisit,
  PaperVisitCancel,
  PaperVisitClose,
  PatientDocumentRetire,
} from './schemas.js';

/**
 * The paper OPD visit (#1202): whoever holds `encounter:recordPaper` checks who the token is for,
 * opens the visit under the token's doctor, attaches the scanned sheet (the module's ordinary
 * upload) and closes the visit, or cancels one opened by mistake while it is empty (#1214). A sheet is never opened from here: reading it still needs
 * `diagnosis:read` (`sheets.ts`).
 */

const FEATURE = 'documents';
const PAPER = 'encounter:recordPaper';
const UPLOAD = 'document:upload';
const QUEUE_READ = 'queue:read';

const tokenNotFound = () => new HttpError(404, 'token_not_found', 'No such token today');
const encounterNotFound = () => new HttpError(404, 'encounter_not_found', 'No such encounter');
const documentNotFound = () => new HttpError(404, 'document_not_found', 'No such document');

function userIdOf(request: FastifyRequest): string {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
}

/** The other modules a route stands on, beside `documents`. */
async function requireModules(request: FastifyRequest, modules: readonly string[]) {
  const policy = await request.access.policy();
  for (const module of modules) {
    if (policy?.features[module] !== true) {
      throw new HttpError(403, 'feature_disabled', `Module ${module} is off for this hospital`);
    }
  }
}

/** Every answer names the patient, so the caller's patient:read must reach them. */
async function readsPatient(request: FastifyRequest, patientId: string): Promise<boolean> {
  const policy = await request.access.policy();
  const grant = policy?.permissions.find((held) => held.permission === 'patient:read');
  if (!grant || policy?.features.patients !== true) return false;
  return patientInScope(request.txClient, patientId, {
    scope: grant.scope ?? 'all',
    userId: userIdOf(request),
  });
}

/** Today's token, within the scope of both permissions, of a patient the caller may read. */
async function tokenOf(request: FastifyRequest, tokenId: string) {
  await requireModules(request, ['clinical', 'queue']);
  const reached = (permission: typeof QUEUE_READ | typeof PAPER) =>
    todaysToken(request.txClient, tokenId, {
      scope: request.access.scope(permission),
      userId: userIdOf(request),
    });
  const token = (await reached(QUEUE_READ)) && (await reached(PAPER));
  if (!token || !(await readsPatient(request, token.patient_id))) throw tokenNotFound();
  // The sheet could not be attached outside the scope of document:upload: refused before opening.
  const mayAttach = await patientInScope(request.txClient, token.patient_id, {
    scope: request.access.scope(UPLOAD),
    userId: userIdOf(request),
  });
  if (!mayAttach) throw tokenNotFound();
  if (token.status === 'cancelled') {
    throw new HttpError(409, 'token_cancelled', 'The token is cancelled');
  }
  return {
    id: token.id,
    number: token.number,
    patientId: token.patient_id,
    patientName: token.patient_name,
    patientMrn: token.patient_mrn,
    doctorId: token.doctor_id,
    doctorName: token.doctor_name,
    appointmentId: token.appointment_id,
  };
}

/** An OPD visit within the caller's scope, of a patient they may read. */
async function visitOf(request: FastifyRequest, encounterId: string) {
  await requireModules(request, ['clinical']);
  const visit = await findPaperVisit(request, encounterId, PAPER);
  if (!visit || !(await readsPatient(request, visit.patientId))) throw encounterNotFound();
  if (visit.type !== 'opd') {
    throw new HttpError(409, 'not_opd_visit', 'Only an OPD visit is kept on paper');
  }
  return visit;
}

/**
 * Whether a file (not retired, whatever its category or uploader), a consent, billing, a surgery,
 * an ambulance trip or an admission raised from it is on the visit. A file the scan blocked is
 * gone, so it does not count.
 */
async function holdsSomething(request: FastifyRequest, encounterId: string): Promise<boolean> {
  const { rowCount } = await request.txClient.query(
    `select 1 from patient_documents
     where encounter_id = $1 and retired_at is null and status in ('pending', 'scanning', 'clean')
     union all
     select 1 from patient_consents where encounter_id = $1
     limit 1`,
    [encounterId],
  );
  if ((rowCount ?? 0) > 0) return true;
  for (const held of [hasStandingBilling, hasSurgeryOn, hasAmbulanceTripOn, hasAdmissionFrom]) {
    if (await held(request.txClient, encounterId)) return true;
  }
  return false;
}

/** A visit as answered, with the caller's own sheets on it. Everything read is audited. */
async function visitAnswer(
  request: FastifyRequest,
  visit: PaperVisitRecord,
  knownNumber?: number,
): Promise<PaperVisit> {
  const tokenNumber =
    knownNumber ??
    (visit.queueTokenId ? await tokenNumberOf(request.txClient, visit.queueTokenId) : null);
  const { rows: sheets } = await request.txClient.query<{
    id: string;
    file_name: string;
    status: PaperVisit['sheets'][number]['status'];
    created_at: Date;
    version: number;
  }>(
    `select id, file_name, status, created_at, version from patient_documents
     where encounter_id = $1 and category = 'opd_sheet' and created_by = $2 and retired_at is null
     order by created_at desc, id desc limit 20`,
    [visit.id, userIdOf(request)],
  );
  // A sheet being scanned counts: the uploader is told if the scan blocks it.
  const { rowCount } = await request.txClient.query(
    `select 1 from patient_documents
     where encounter_id = $1 and category = 'opd_sheet' and retired_at is null
       and status in ('scanning', 'clean') limit 1`,
    [visit.id],
  );
  const canCancel =
    visit.status === 'open' &&
    visit.type === 'opd' &&
    visit.openedFromPaper &&
    (await isUnwrittenVisit(request, visit.id)) &&
    !(await holdsSomething(request, visit.id));
  request.audit('read', 'encounter', visit.id);
  for (const sheet of sheets) request.audit('read', 'patient_document', sheet.id);
  return {
    patientId: visit.patientId,
    patientName: visit.patientName,
    patientMrn: visit.patientMrn,
    ...(tokenNumber === null ? {} : { tokenNumber }),
    ...(visit.doctorName ? { doctorName: visit.doctorName } : {}),
    encounter: {
      id: visit.id,
      status: visit.status,
      openedAt: visit.openedAt.toISOString(),
      version: visit.version,
    },
    hasSheet: (rowCount ?? 0) > 0,
    canCancel,
    sheets: sheets.map((sheet) => ({
      id: sheet.id,
      fileName: sheet.file_name,
      status: sheet.status,
      createdAt: sheet.created_at.toISOString(),
      version: sheet.version,
    })),
  };
}

/** What is answered for one of today's tokens: its visit, or who it is for when it has none. */
async function tokenAnswer(
  request: FastifyRequest,
  token: Awaited<ReturnType<typeof tokenOf>>,
  visit: PaperVisitRecord | null,
): Promise<PaperVisit> {
  if (visit) return visitAnswer(request, visit, token.number);
  request.audit('read', 'queue_token', token.id);
  return {
    patientId: token.patientId,
    patientName: token.patientName,
    patientMrn: token.patientMrn,
    tokenNumber: token.number,
    ...(token.doctorName ? { doctorName: token.doctorName } : {}),
    hasSheet: false,
    canCancel: false,
    sheets: [],
  };
}

const TOKEN_REFUSALS =
  ' A token of another day, another hospital, outside the scope of queue:read or encounter:recordPaper, or of a patient outside the scope of patient:read or document:upload is 404 `token_not_found`; a cancelled one is 409 `token_cancelled`. 409 `already_open` when the token and its appointment each opened a visit, or the visit is outside the caller’s scope. Requires queue:read, encounter:recordPaper, document:upload and patient:read, and the documents, clinical and queue feature flags.';
const VISIT_REFUSALS =
  ' A visit of another hospital, outside the scope of encounter:recordPaper or of a patient the caller may not read is 404 `encounter_not_found`; one that is not OPD is 409 `not_opd_visit`.';

export const paperVisitRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/queue/tokens/:tokenId/paper-visit',
    {
      config: { permissions: [QUEUE_READ, PAPER, UPLOAD], feature: FEATURE },
      schema: {
        operationId: 'getTokenPaperVisit',
        tags: ['documents'],
        description:
          'Who one of today’s tokens is for, to be checked against the paper before a scanned OPD sheet is attached (#1202), with the token’s visit when there is one. Nothing changes. Audited.' +
          TOKEN_REFUSALS,
        params: PaperTokenParams,
        response: { 200: ref(PaperVisit), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const token = await tokenOf(request, request.params.tokenId);
      return tokenAnswer(request, token, await findPaperVisitOfToken(request, token, PAPER));
    },
  );

  app.post(
    '/queue/tokens/:tokenId/paper-visit',
    {
      config: {
        permissions: [QUEUE_READ, PAPER, UPLOAD],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'openTokenPaperVisit',
        tags: ['documents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Opens the visit of one of today’s tokens under the token’s doctor, to attach a scanned OPD sheet to it (#1202), or answers the visit already open for the token or its appointment. A token issued for no doctor is 422 `token_without_doctor`; a doctor who does not practise here, or is outside the scope of encounter:recordPaper, is 422 `unknown_doctor`. A new visit is audited and emits `encounter.opened`, as one a doctor starts. The Idempotency-Key header is required: a repeat opens nothing.' +
          TOKEN_REFUSALS,
        params: PaperTokenParams,
        response: { 200: ref(PaperVisit), ...errors(401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const token = await tokenOf(request, request.params.tokenId);
      const visit =
        request.replayOf === null
          ? await openPaperVisit(request, token, PAPER)
          : await findPaperVisitOfToken(request, token, PAPER);
      return tokenAnswer(request, token, visit);
    },
  );

  app.get(
    '/encounters/:encounterId/paper-visit',
    {
      config: { permissions: [PAPER], feature: FEATURE },
      schema: {
        operationId: 'getPaperVisit',
        tags: ['documents'],
        description:
          'Who a visit is for, whether an OPD sheet is on it and the sheets the caller attached (#1202). Audited. Requires encounter:recordPaper and patient:read, and the documents and clinical feature flags.' +
          VISIT_REFUSALS,
        params: PaperEncounterParams,
        response: { 200: ref(PaperVisit), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => visitAnswer(request, await visitOf(request, request.params.encounterId)),
  );

  app.post(
    '/encounters/:encounterId/paper-visit/close',
    {
      config: {
        permissions: [PAPER],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'closePaperVisit',
        tags: ['documents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Closes a visit kept on paper (#1202). Refused unless an OPD sheet that is clean or being scanned, and not retired, is on the visit (409 `opd_sheet_required`), and as an ordinary close is: 409 `invalid_transition` for one not open, `conflict` for another version, `unsigned_notes`, `managed_by_admission`, `managed_by_emergency`; and 409 `has_records` for a visit with a signed note, diagnosis, order, prescription, referral or follow-up, which is closed from the consultation. Emits `encounter.closed`. A sheet the scan blocks afterwards leaves the visit closed; its uploader is told. The Idempotency-Key header is required: a repeat changes nothing. Requires encounter:recordPaper and patient:read, and the documents and clinical feature flags.' +
          VISIT_REFUSALS,
        params: PaperEncounterParams,
        body: ref(PaperVisitClose),
        response: { 200: ref(PaperVisit), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { encounterId } = request.params;
      const before = await visitOf(request, encounterId);
      if (request.replayOf !== null) return visitAnswer(request, before);
      const { version } = request.body as PaperVisitClose;
      await closePaperVisit(request, { id: before.id, version }, PAPER, async () => {
        // Locked, so a sheet is not retired while the visit closes on it.
        const { rowCount } = await request.txClient.query(
          `select 1 from patient_documents
           where encounter_id = $1 and category = 'opd_sheet' and retired_at is null
             and status in ('scanning', 'clean') for share`,
          [before.id],
        );
        if (!rowCount) {
          throw new HttpError(409, 'opd_sheet_required', 'Attach the OPD sheet first');
        }
      });
      return visitAnswer(request, await visitOf(request, encounterId));
    },
  );

  app.post(
    '/encounters/:encounterId/paper-visit/cancel',
    {
      config: {
        permissions: [PAPER],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'cancelPaperVisit',
        tags: ['documents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Cancels a visit opened from paper by mistake, such as under the wrong token (#1214), with a reason. Only a visit this paper flow opened (409 `not_paper_visit`; any other needs encounter:update) and only while it is empty: 409 `unsigned_notes` for a draft note; `has_records` for a signed note, diagnosis, order, prescription, referral or follow-up; `visit_not_empty` for a file of any kind that is not retired (one blocked by the scan does not count), a consent naming the visit, a charge or invoice not void, a surgery or ambulance trip not cancelled, or an admission raised from it. Retire a wrong sheet first. 409 `invalid_transition` for one not open, `conflict` for another version. The token or appointment may then open another visit. Emits `encounter.cancelled`. The Idempotency-Key header is required: a repeat changes nothing. Requires encounter:recordPaper and patient:read, and the documents and clinical feature flags.' +
          VISIT_REFUSALS,
        params: PaperEncounterParams,
        body: ref(PaperVisitCancel),
        response: { 200: ref(PaperVisit), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { encounterId } = request.params;
      const before = await visitOf(request, encounterId);
      if (request.replayOf !== null) return visitAnswer(request, before);
      const body = request.body as PaperVisitCancel;
      const reason = tidyWithin(body.reason, 200);
      if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is needed');
      // Asked with the visit locked: an upload waits for the cancel, or is seen by it.
      await cancelPaperVisit(
        request,
        { id: before.id, version: body.version, reason },
        PAPER,
        async () => {
          if (await holdsSomething(request, before.id)) {
            throw new HttpError(409, 'visit_not_empty', 'Something is on the visit');
          }
        },
      );
      return visitAnswer(request, await visitOf(request, encounterId));
    },
  );

  app.post(
    '/encounters/:encounterId/paper-visit/sheets/:documentId/retire',
    {
      config: { permissions: [PAPER, UPLOAD], feature: FEATURE },
      schema: {
        operationId: 'retireOwnOpdSheet',
        tags: ['documents'],
        description:
          'Retires an OPD sheet the caller attached to this visit by mistake, with a reason (#1202); they then attach it to the right visit. It stays on the record, as any retired document. Only the caller’s own sheet of this visit: anything else is 404 `document_not_found` (document:retire retires any document). 409 `already_retired`, `conflict`. A visit already closed stays closed. Requires encounter:recordPaper, document:upload and patient:read, and the documents and clinical feature flags.' +
          VISIT_REFUSALS,
        params: PaperSheetParams,
        body: ref(PatientDocumentRetire),
        response: { 200: ref(PaperVisit), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const visit = await visitOf(request, request.params.encounterId);
      const { documentId } = request.params;
      const body = request.body as PatientDocumentRetire;
      const { rows } = await request.txClient.query<{
        retired_at: Date | null;
        version: number;
      }>(
        `select retired_at, version from patient_documents
         where id = $1 and encounter_id = $2 and category = 'opd_sheet' and created_by = $3
         for update`,
        [documentId, visit.id, userIdOf(request)],
      );
      const sheet = rows[0];
      if (!sheet) throw documentNotFound();
      if (sheet.retired_at) throw new HttpError(409, 'already_retired', 'Already retired');
      if (sheet.version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The document has changed since it was read');
      }
      const reason = tidyWithin(body.reason, 300);
      if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is needed');
      await request.txClient.query(
        `update patient_documents set retired_at = now(), retired_by = $2, retired_reason = $3
         where id = $1`,
        [documentId, userIdOf(request), reason],
      );
      request.audit('update', 'patient_document', documentId);
      return visitAnswer(request, visit);
    },
  );
};
