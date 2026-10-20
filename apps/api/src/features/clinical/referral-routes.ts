import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { encounterFor, FEATURE, invalid, userIdOf } from './http.js';
import {
  activeDepartment,
  cancelReferral,
  findReferral,
  insertReferral,
  listReferrals,
  type ReferralRow,
} from './referral-repository.js';
import { practisingDoctor } from './repository.js';
import {
  EncounterParams,
  PageQuery,
  REASON_MAX,
  Referral,
  ReferralCancel,
  ReferralCreate,
  ReferralPage,
  ReferralParams,
  REFERRAL_REASON_MAX,
} from './schemas.js';

const READ = 'referral:read';
const CREATE = 'referral:create';

const notFound = () => new HttpError(404, 'referral_not_found', 'No such referral');

const SCOPE =
  ' The encounter decides who reaches it: one of another hospital, or outside the scope the caller holds the route’s permission with, is 404 as one that does not exist.';

const optional = <Key extends string, Value>(key: Key, value: Value | null) =>
  (value === null ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

export const referralView = (row: ReferralRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  departmentId: row.department_id,
  departmentName: row.department_name,
  ...optional('doctorId', row.doctor_id),
  ...optional('doctorName', row.doctor_name),
  urgency: row.urgency,
  reason: row.reason,
  referredAt: row.referred_at.toISOString(),
  referredByName: row.referred_by_name,
  ...optional('cancelledAt', row.cancelled_at?.toISOString() ?? null),
  ...optional('cancelledByName', row.cancelled_by_name),
  ...optional('cancelReason', row.cancel_reason),
});

/** Referrals (#88): to a department of the hospital, or one of its doctors. */
export const referralRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/encounters/:encounterId/referrals',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listReferrals',
        tags: ['clinical'],
        description:
          'The encounter’s referrals, oldest first, cancelled ones included with who cancelled them and why. Requires referral:read and the clinical feature flag. Every referral of a page is audited.' +
          SCOPE,
        params: EncounterParams,
        querystring: PageQuery,
        response: { 200: ref(ReferralPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const encounter = await encounterFor(request, request.params.encounterId, READ);
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listReferrals(request.txClient, encounter.id, {
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'referral', row.id);
      return {
        items: page.rows.map(referralView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  /** A referral in an encounter the caller reaches with `permission`; locked once that is checked. */
  async function referralFor(
    request: FastifyRequest,
    id: string,
    permission: Permission,
    { forUpdate = false }: { forUpdate?: boolean } = {},
  ) {
    const row = await findReferral(request.txClient, id);
    if (!row) throw notFound();
    try {
      await encounterFor(request, row.encounter_id, permission);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'encounter_not_found') throw notFound();
      throw error;
    }
    if (!forUpdate) return row;
    const locked = await findReferral(request.txClient, row.id, { forUpdate: true });
    if (!locked) throw notFound();
    return locked;
  }

  app.post(
    '/encounters/:encounterId/referrals',
    {
      config: {
        // The answer holds the reason, which is referral:read's.
        permissions: [READ, CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createReferral',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Refers the patient of an open encounter (409 `encounter_not_open` otherwise) to a department of the hospital, or to one of its doctors, with a reason and an urgency. A department, a doctor or both (400 with neither): a doctor alone gives their department; a department archived, unknown or of another hospital is 422 `unknown_department`; a doctor who does not practise here is 422 `unknown_doctor`, and one of another department than the one named is 422 `doctor_not_in_department`. A referral is never changed: one made in error is cancelled. The Idempotency-Key header is required: a repeat refers nothing and answers with the referral as it is now. Requires referral:read and referral:create, and the clinical feature flag. Audited, and emits `referral.created` through the outbox with ids and the urgency, never the reason.' +
          SCOPE,
        params: EncounterParams,
        body: ref(ReferralCreate),
        response: { 201: ref(Referral), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const made = request.idempotentId
          ? await referralFor(request, request.idempotentId, CREATE)
          : null;
        if (!made) throw notFound();
        request.audit('read', 'referral', made.id);
        return reply.status(201).send(referralView(made));
      }
      const body = request.body as ReferralCreate;
      const userId = userIdOf(request);
      const reason = tidyLinesOptional(body.reason, REFERRAL_REASON_MAX);
      if (reason === null) throw invalid('A reason is needed');
      if (body.departmentId === undefined && body.doctorId === undefined) {
        throw invalid('A department or a doctor is needed');
      }
      const encounter = await encounterFor(request, request.params.encounterId, CREATE, {
        open: true,
      });
      // Any doctor who practises here: a referral goes to someone else by its nature.
      const doctor =
        body.doctorId === undefined
          ? null
          : await practisingDoctor(request.txClient, body.doctorId, { scope: 'all', userId });
      if (body.doctorId !== undefined && !doctor) {
        throw new HttpError(422, 'unknown_doctor', 'No such doctor');
      }
      const departmentId = body.departmentId ?? doctor?.department_id;
      if (departmentId === undefined || !(await activeDepartment(request.txClient, departmentId))) {
        throw new HttpError(422, 'unknown_department', 'No such department');
      }
      if (doctor && doctor.department_id !== departmentId) {
        throw new HttpError(422, 'doctor_not_in_department', 'The doctor is of another department');
      }
      const id = await insertReferral(
        request.txClient,
        {
          encounterId: encounter.id,
          patientId: encounter.patient_id,
          departmentId,
          doctorId: doctor?.id ?? null,
          urgency: body.urgency,
          reason,
        },
        userId,
      );
      request.idempotentId = id;
      request.audit('create', 'referral', id);
      await request.emit('referral.created', id, {
        referralId: id,
        encounterId: encounter.id,
        patientId: encounter.patient_id,
        departmentId,
        ...(doctor ? { doctorId: doctor.id } : {}),
        urgency: body.urgency,
      });
      const made = await findReferral(request.txClient, id);
      if (!made) throw new Error('referral was not written');
      return reply.status(201).send(referralView(made));
    },
  );

  app.post(
    '/referrals/:referralId/cancel',
    {
      config: {
        // The answer holds the reason, which is referral:read's.
        permissions: [READ, CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'cancelReferral',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Cancels a referral with a reason: it stays, with who cancelled it and when. Once (409 `already_cancelled`), and also after the encounter closed. The Idempotency-Key header is required: a repeat changes nothing and answers with the referral as it is now. Requires referral:read and referral:create, and the clinical feature flag. Audited, and emits `referral.cancelled` through the outbox.' +
          SCOPE,
        params: ReferralParams,
        body: ref(ReferralCancel),
        response: { 200: ref(Referral), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const id = request.params.referralId;
      if (request.replayOf === null) {
        const reason = tidyWithin((request.body as ReferralCancel).reason, REASON_MAX);
        if (reason === '') throw invalid('A reason is needed');
        const row = await referralFor(request, id, CREATE, { forUpdate: true });
        if (row.cancelled_at !== null) {
          throw new HttpError(409, 'already_cancelled', 'The referral is already cancelled');
        }
        await cancelReferral(request.txClient, row.id, reason, userIdOf(request));
        request.audit('update', 'referral', row.id);
        await request.emit('referral.cancelled', row.id, {
          referralId: row.id,
          encounterId: row.encounter_id,
          patientId: row.patient_id,
        });
      }
      const now = await referralFor(request, id, CREATE);
      if (request.replayOf !== null) request.audit('read', 'referral', now.id);
      return reply.status(200).send(referralView(now));
    },
  );
};
