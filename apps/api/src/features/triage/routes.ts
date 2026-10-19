import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  findAllergies,
  findVitals,
  hospitalRanges,
  insertVitals,
  isAdult,
  listVitals,
  patientExists,
  replaceAllergies,
  tokenOfPatientToday,
  type VitalsRow,
} from './repository.js';
import {
  ALLERGIES_MAX,
  AllergyList,
  AllergyListUpdate,
  COMPLAINT_MAX,
  CORRECTION_REASON_MAX,
  LIMITS,
  MEASURES,
  PatientParams,
  REACTION_MAX,
  SUBSTANCE_MAX,
  TRIAGE_SCHEMAS,
  VitalRanges,
  Vitals,
  VitalsCreate,
  VitalsListQuery,
  VitalsPage,
  VitalsParams,
  type Allergy,
  type Measure,
} from './schemas.js';

const FEATURE = 'triage';
const READ = 'vitals:read';
const RECORD = 'vitals:record';
const ALLERGY_READ = 'allergy:read';
const ALLERGY_UPDATE = 'allergy:update';

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const patientNotFound = () => new HttpError(404, 'not_found', 'Patient not found');

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const reading = (row: VitalsRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  patientId: row.patient_id,
  ...(row.queue_token_id === null ? {} : { queueTokenId: row.queue_token_id }),
  ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
  recordedAt: row.recorded_at.toISOString(),
  recordedById: row.recorded_by,
  recordedByName: row.recorded_by_name,
  ...Object.fromEntries(
    MEASURES.flatMap((name) => (row[name] === null ? [] : [[name, row[name]]])),
  ),
  ...(row.chief_complaint === null ? {} : { chiefComplaint: row.chief_complaint }),
  ...(row.corrects_id === null ? {} : { correctsId: row.corrects_id }),
  ...(row.correction_reason === null ? {} : { correctionReason: row.correction_reason }),
});

/** The measurements of a body: whole numbers or one decimal, within what a body can be. */
function measuresOf(body: VitalsCreate): Partial<Record<Measure, number>> {
  const values = body as Partial<Record<Measure, number>>;
  const measures: Partial<Record<Measure, number>> = {};
  for (const name of MEASURES) {
    const value = values[name];
    if (value === undefined) continue;
    const { minimum, maximum } = LIMITS[name];
    // The schema checks the range; to one decimal is checked here, as JSON Schema's multipleOf
    // is not exact for decimals.
    if (value < minimum || value > maximum || Number(value.toFixed(1)) !== value) {
      throw invalid(`${name} is not a value the API takes`);
    }
    measures[name] = value;
  }
  if ((measures.systolic === undefined) !== (measures.diastolic === undefined)) {
    throw invalid('Systolic and diastolic go together');
  }
  if (
    measures.systolic !== undefined &&
    measures.diastolic !== undefined &&
    measures.diastolic >= measures.systolic
  ) {
    throw invalid('The diastolic is below the systolic');
  }
  return measures;
}

/** The refusal for a correction the unique index turned down, or the error itself. */
function correctionRefusal(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === '23505' && constraint === 'vitals_corrected_once') {
    return new HttpError(422, 'already_corrected', 'The reading is already corrected');
  }
  return error;
}

function allergyView(
  patientId: string,
  tenantId: string,
  row: Awaited<ReturnType<typeof findAllergies>>,
) {
  if (!row) return { patientId, tenantId, status: 'unknown' as const, items: [], version: 0 };
  return {
    patientId: row.patient_id,
    tenantId: row.tenant_id,
    status: row.status,
    items: row.items,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    ...(row.updated_by_name === null ? {} : { updatedByName: row.updated_by_name }),
  };
}

export const triageRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of TRIAGE_SCHEMAS) app.addSchema(schema);

  const tenantIdOf = (request: FastifyRequest): string => {
    const id = request.tenant?.id;
    if (!id) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');
    return id;
  };

  app.get(
    '/patients/:patientId/vitals',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listVitals',
        tags: ['triage'],
        description:
          'The patient’s readings, newest first, corrections and the readings they correct included. Optionally only those taken for one queue token. A list, not a search: nothing typed in its address says anything about the patient, so it is a GET. A patient the hospital does not have is 404 `not_found`. Requires vitals:read and the triage feature flag. Every reading of a page is audited in the request’s transaction. `total` comes with the first page only.',
        params: PatientParams,
        querystring: VitalsListQuery,
        response: { 200: ref(VitalsPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      if (!(await patientExists(request.txClient, patientId))) throw patientNotFound();
      const { queueTokenId, cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listVitals(request.txClient, patientId, {
        ...(queueTokenId === undefined ? {} : { queueTokenId }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'vitals', row.id);
      return {
        items: page.rows.map(reading),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/patients/:patientId/vitals',
    {
      // A clinical answer is never kept a second time: only the new id, for a repeat.
      config: {
        permissions: [RECORD],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'recordVitals',
        tags: ['triage'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a reading: at least one measurement or a chief complaint, the measurements whole numbers or to one decimal within what a body can be, systolic and diastolic together with the diastolic below the systolic (400 `validation_failed` otherwise). The token must be this patient’s and today’s at the hospital, in any status (a re-check after the consultation is allowed); otherwise 422 `token_not_for_patient`. A correction names a reading of this patient (422 `unknown_correction`) that no other reading corrects yet (422 `already_corrected`, decided by a unique index), with a reason, and takes that reading’s queueTokenId and encounterId: a queueTokenId sent with a correction, or a reason without one, is refused (400). A patient the hospital does not have is 404 `not_found`. The Idempotency-Key header is required and kept per hospital and user: a repeat records nothing and answers with the reading. Audited in the request’s transaction, and emits `vitals.recorded` through the outbox (the reading’s id, patientId, queueTokenId and correctsId when there are, the actor and the time). Requires vitals:record and the triage feature flag.',
        params: PatientParams,
        body: ref(VitalsCreate),
        response: { 201: ref(Vitals), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const { patientId } = request.params;
      if (request.replayOf !== null) {
        const recorded = request.idempotentId
          ? await findVitals(request.txClient, patientId, request.idempotentId)
          : null;
        if (!recorded) throw new HttpError(404, 'not_found', 'Reading not found');
        request.audit('read', 'vitals', recorded.id);
        return reply.status(201).send(reading(recorded));
      }
      const body = request.body as VitalsCreate;
      const measures = measuresOf(body);
      const chiefComplaint = tidyLinesOptional(body.chiefComplaint, COMPLAINT_MAX);
      const correctionReason = tidyOptional(body.correctionReason, CORRECTION_REASON_MAX);
      if (Object.keys(measures).length === 0 && chiefComplaint === null) {
        throw invalid('A measurement or a chief complaint is needed');
      }
      if ((body.correctsId === undefined) !== (correctionReason === null)) {
        throw invalid('A correction and its reason go together');
      }
      if (body.correctsId !== undefined && body.queueTokenId !== undefined) {
        throw invalid('A correction takes the token of the reading it corrects');
      }
      if (!(await patientExists(request.txClient, patientId))) throw patientNotFound();

      let queueTokenId: string | null = null;
      let encounterId: string | null = null;
      if (body.correctsId !== undefined) {
        const corrected = await findVitals(request.txClient, patientId, body.correctsId);
        if (!corrected) throw new HttpError(422, 'unknown_correction', 'No such reading');
        queueTokenId = corrected.queue_token_id;
        encounterId = corrected.encounter_id;
      } else if (body.queueTokenId !== undefined) {
        if (!(await tokenOfPatientToday(request.txClient, body.queueTokenId, patientId))) {
          throw new HttpError(422, 'token_not_for_patient', 'Not this patient’s token today');
        }
        queueTokenId = body.queueTokenId;
      }

      let id: string;
      try {
        id = await insertVitals(
          request.txClient,
          {
            patientId,
            queueTokenId,
            encounterId,
            measures,
            chiefComplaint,
            correctsId: body.correctsId ?? null,
            correctionReason,
          },
          userIdOf(request),
        );
      } catch (error) {
        throw correctionRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'vitals', id);
      await request.emit('vitals.recorded', id, {
        vitalsId: id,
        patientId,
        ...(queueTokenId === null ? {} : { queueTokenId }),
        ...(body.correctsId === undefined ? {} : { correctsId: body.correctsId }),
      });
      const recorded = await findVitals(request.txClient, patientId, id);
      if (!recorded) throw new Error('reading was not recorded');
      return reply.status(201).send(reading(recorded));
    },
  );

  app.get(
    '/patients/:patientId/vitals/:vitalsId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getVitals',
        tags: ['triage'],
        description:
          'One reading of the patient. A reading of another patient, of another hospital or of none is 404 `not_found`. Requires vitals:read and the triage feature flag. Audited.',
        params: VitalsParams,
        response: { 200: ref(Vitals), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findVitals(
        request.txClient,
        request.params.patientId,
        request.params.vitalsId,
      );
      if (!row) throw new HttpError(404, 'not_found', 'Reading not found');
      request.audit('read', 'vitals', row.id);
      return reading(row);
    },
  );

  app.get(
    '/patients/:patientId/vital-ranges',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getVitalRanges',
        tags: ['triage'],
        description:
          'The hospital’s normal ranges that apply to this patient, decided by the server from the patient’s age on today’s date at the hospital: the hospital’s adult ranges, or the built-in ones while it has set none, for a patient of 18 or over; null for a patient under 18 (#379). A patient the hospital does not have is 404 `not_found`. Audited, as it tells whether the patient is under 18. Requires vitals:read and the triage feature flag.',
        params: PatientParams,
        response: { 200: ref(VitalRanges), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      const adult = await isAdult(request.txClient, patientId);
      if (adult === null) throw patientNotFound();
      request.audit('read', 'vital_ranges', patientId);
      return { ranges: adult ? await hospitalRanges(request.txClient) : null };
    },
  );

  app.get(
    '/patients/:patientId/allergies',
    {
      config: { permissions: [ALLERGY_READ], feature: FEATURE },
      schema: {
        operationId: 'getAllergies',
        tags: ['triage'],
        description:
          'The patient’s allergies; status `unknown` and version 0 while never recorded, which is not the same as `none` (asked, no known allergies). A patient the hospital does not have is 404 `not_found`. Requires allergy:read and the triage feature flag. Audited.',
        params: PatientParams,
        response: { 200: ref(AllergyList), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      if (!(await patientExists(request.txClient, patientId))) throw patientNotFound();
      request.audit('read', 'allergy_list', patientId);
      return allergyView(
        patientId,
        tenantIdOf(request),
        await findAllergies(request.txClient, patientId),
      );
    },
  );

  app.put(
    '/patients/:patientId/allergies',
    {
      config: { permissions: [ALLERGY_UPDATE], feature: FEATURE },
      schema: {
        operationId: 'setAllergies',
        tags: ['triage'],
        description: `Replaces the patient’s allergies whole, from the version the edit started from (0 while never recorded); another change first is 409 \`conflict\`, and nothing changes. \`none\` with no items, \`listed\` with 1 to ${ALLERGIES_MAX} (400 otherwise); substances and reactions are plain text, tidied. A patient the hospital does not have is 404 \`not_found\`. Requires allergy:update and the triage feature flag. Audited in the request’s transaction, and emits \`allergy.updated\` through the outbox (patientId and the new version; never the allergies themselves).`,
        params: PatientParams,
        body: ref(AllergyListUpdate),
        response: { 200: ref(AllergyList), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      const body = request.body as AllergyListUpdate;
      const items: Allergy[] = body.items.map((item) => {
        const reaction = tidyOptional(item.reaction, REACTION_MAX);
        const substance = tidyWithin(item.substance, SUBSTANCE_MAX);
        if (substance === '') throw invalid('A substance is needed');
        return { substance, ...(reaction === null ? {} : { reaction }), severity: item.severity };
      });
      if ((body.status === 'none') !== (items.length === 0)) {
        throw invalid('`none` has no items and `listed` has at least one');
      }
      if (!(await patientExists(request.txClient, patientId))) throw patientNotFound();
      const replaced = await replaceAllergies(
        request.txClient,
        patientId,
        body.version,
        { status: body.status, items },
        userIdOf(request),
      );
      if (!replaced) throw new HttpError(409, 'conflict', 'Changed by someone else');
      const now = await findAllergies(request.txClient, patientId);
      if (!now) throw new Error('allergies were not saved');
      request.audit('update', 'allergy_list', patientId);
      await request.emit('allergy.updated', patientId, { patientId, version: now.version });
      return allergyView(patientId, tenantIdOf(request), now);
    },
  );
};
