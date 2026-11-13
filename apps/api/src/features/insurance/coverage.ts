import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { todayAtHospital } from '../../core/tenancy/today.js';
import {
  EncounterParams,
  PatientParams,
  PatientPolicy,
  PatientPolicyCreate,
  PatientPolicyEnd,
  PolicyParams,
  PreAuth,
  PreAuthCancel,
  PreAuthCreate,
  PreAuthDecision,
  PreAuthParams,
} from './schemas.js';
import { isCode, isUuid, requirePatient, tidy, userIdOf } from './util.js';

const FEATURE = 'insurance';

// --- policies ----------------------------------------------------------------------------------

interface PolicyRow {
  id: string;
  patient_id: string;
  payer_id: string;
  payer_name: string;
  plan_id: string;
  plan_name: string;
  policy_number: string;
  member_id: string | null;
  holder_name: string;
  relationship: PatientPolicy['relationship'];
  valid_from: string;
  valid_to: string | null;
  status: PatientPolicy['status'];
  pre_auth_required: boolean;
  version: number;
}
/** `$1` is today at the hospital. */
const POLICIES = `select x.id, x.patient_id, x.payer_id, py.name as payer_name, x.plan_id,
       pl.name as plan_name, x.policy_number, x.member_id, x.holder_name, x.relationship,
       x.valid_from::text, x.valid_to::text,
       case when x.ended_at is not null then 'ended'
            when x.valid_to is not null and x.valid_to < $1::date then 'expired'
            else 'active' end as status,
       pl.pre_auth_required, x.version
  from patient_policies x
  join payers py on py.tenant_id = x.tenant_id and py.id = x.payer_id
  join payer_plans pl on pl.tenant_id = x.tenant_id and pl.id = x.plan_id`;
const policyView = (row: PolicyRow): PatientPolicy => ({
  id: row.id,
  patientId: row.patient_id,
  payerId: row.payer_id,
  payerName: row.payer_name,
  planId: row.plan_id,
  planName: row.plan_name,
  policyNumber: row.policy_number,
  ...(row.member_id === null ? {} : { memberId: row.member_id }),
  holderName: row.holder_name,
  relationship: row.relationship,
  validFrom: row.valid_from,
  ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
  status: row.status,
  preAuthRequired: row.pre_auth_required,
  version: row.version,
});

async function findPolicy(
  client: pg.ClientBase,
  today: string,
  id: string,
  lock = false,
): Promise<PolicyRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<PolicyRow>(
    `${POLICIES} where x.id = $2 ${lock ? 'for update of x' : ''}`,
    [today, id],
  );
  return rows[0] ?? null;
}

// --- pre-authorizations ------------------------------------------------------------------------

interface PreAuthRow {
  id: string;
  patient_id: string;
  policy_id: string;
  payer_name: string;
  plan_name: string;
  policy_number: string;
  encounter_id: string | null;
  treatment: string;
  requested_minor: string;
  approved_minor: string | null;
  billed_minor: string;
  status: PreAuth['status'];
  reference_number: string | null;
  decision_note: string | null;
  documents: string[];
  requested_at: Date;
  decided_at: Date | null;
  version: number;
}
const PRE_AUTHS = `select a.id, a.patient_id, a.policy_id, py.name as payer_name, pl.name as plan_name,
       pol.policy_number, a.encounter_id, a.treatment, a.requested_minor, a.approved_minor,
       coalesce((select sum(c.total_minor) from charges c
                  where c.tenant_id = a.tenant_id and c.encounter_id = a.encounter_id
                    and c.status <> 'void'), 0) as billed_minor,
       a.status, a.reference_number, a.decision_note, a.documents, a.requested_at, a.decided_at,
       a.version
  from pre_auths a
  join patient_policies pol on pol.tenant_id = a.tenant_id and pol.id = a.policy_id
  join payers py on py.tenant_id = pol.tenant_id and py.id = pol.payer_id
  join payer_plans pl on pl.tenant_id = pol.tenant_id and pl.id = pol.plan_id`;
const preAuthView = (row: PreAuthRow): PreAuth => ({
  id: row.id,
  patientId: row.patient_id,
  policyId: row.policy_id,
  payerName: row.payer_name,
  planName: row.plan_name,
  policyNumber: row.policy_number,
  ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
  treatment: row.treatment,
  requestedMinor: Number(row.requested_minor),
  ...(row.approved_minor === null ? {} : { approvedMinor: Number(row.approved_minor) }),
  billedMinor: Number(row.billed_minor),
  status: row.status,
  ...(row.reference_number === null ? {} : { referenceNumber: row.reference_number }),
  ...(row.decision_note === null ? {} : { decisionNote: row.decision_note }),
  documents: row.documents,
  requestedAt: row.requested_at.toISOString(),
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
  version: row.version,
});

async function findPreAuth(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<PreAuthRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<PreAuthRow>(
    `${PRE_AUTHS} where a.id = $1 ${lock ? 'for update of a' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const versionConflict = () =>
  new HttpError(409, 'version_conflict', 'It has changed since it was read');
const preAuthGone = () => new HttpError(404, 'pre_auth_not_found', 'No such request');

export const coverageRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/patients/:patientId/policies',
    {
      config: { permissions: ['policy:read'], feature: FEATURE },
      schema: {
        operationId: 'listPatientPolicies',
        tags: ['insurance'],
        description:
          'The patient’s policies, newest first, with the status worked out from the dates and whether it was ended. Audited as a read of each policy. Requires policy:read and a patient the caller may read.',
        params: PatientParams,
        response: { 200: Type.Array(ref(PatientPolicy)), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      await requirePatient(request, request.params.patientId);
      const today = await todayAtHospital(request.txClient);
      const { rows } = await request.txClient.query<PolicyRow>(
        `${POLICIES} where x.patient_id = $2 order by x.created_at desc, x.id desc`,
        [today, request.params.patientId],
      );
      for (const row of rows) request.audit('read', 'patient_policy', row.id);
      return rows.map(policyView);
    },
  );

  app.post(
    '/patients/:patientId/policies',
    {
      config: {
        permissions: ['policy:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createPatientPolicy',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Puts a policy against a plan on the patient’s record. The last day is not before the first (422 `validation_failed`); an archived plan or organisation takes none (409 `plan_archived`); the same card on the same plan once while it is in force (409 `duplicate_policy`). Audited. Requires policy:manage.',
        params: PatientParams,
        body: PatientPolicyCreate,
        response: { 201: ref(PatientPolicy), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      await requirePatient(request, request.params.patientId);
      if (body.validTo !== undefined && body.validTo < body.validFrom) {
        throw new HttpError(422, 'validation_failed', 'The last day is before the first');
      }
      const plan = isUuid(body.planId)
        ? (
            await client.query<{ payer_id: string; archived: boolean }>(
              `select pl.payer_id, (pl.archived or py.archived) as archived
                 from payer_plans pl
                 join payers py on py.tenant_id = pl.tenant_id and py.id = pl.payer_id
                where pl.id = $1`,
              [body.planId],
            )
          ).rows[0]
        : undefined;
      if (!plan) throw new HttpError(404, 'plan_not_found', 'No such plan');
      if (plan.archived) throw new HttpError(409, 'plan_archived', 'The plan is archived');
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into patient_policies (patient_id, payer_id, plan_id, policy_number, member_id,
             holder_name, relationship, valid_from, valid_to, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [
            request.params.patientId,
            plan.payer_id,
            body.planId,
            tidy(body.policyNumber),
            body.memberId === undefined ? null : tidy(body.memberId),
            tidy(body.holderName),
            body.relationship,
            body.validFrom,
            body.validTo ?? null,
            userIdOf(request),
          ],
        );
        const id = (rows[0] as { id: string }).id;
        request.audit('create', 'patient_policy', id);
        const today = await todayAtHospital(client);
        return reply
          .status(201)
          .send(policyView((await findPolicy(client, today, id)) as PolicyRow));
      } catch (error) {
        if (isCode(error, '23505', 'patient_policies_in_force')) {
          throw new HttpError(409, 'duplicate_policy', 'That policy is on the record already');
        }
        throw error;
      }
    },
  );

  app.post(
    '/patient-policies/:policyId/end',
    {
      config: { permissions: ['policy:manage'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'endPatientPolicy',
        tags: ['insurance'],
        headers: IdempotencyHeaders,
        description:
          'Ends a policy: it backs no new request. Nothing else about a policy is ever edited, and it is ended once (409 `already_ended`). A stale `version` is 409 `version_conflict`. Audited. Requires policy:manage.',
        params: PolicyParams,
        body: PatientPolicyEnd,
        response: { 200: ref(PatientPolicy), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const today = await todayAtHospital(client);
      const probe = await findPolicy(client, today, request.params.policyId);
      if (!probe) throw new HttpError(404, 'policy_not_found', 'No such policy');
      const row = (await findPolicy(client, today, probe.id, true)) as PolicyRow;
      if (row.version !== request.body.version) throw versionConflict();
      if (row.status === 'ended') throw new HttpError(409, 'already_ended', 'It is ended already');
      await client.query(
        'update patient_policies set ended_at = now(), ended_by = $2 where id = $1',
        [row.id, userIdOf(request)],
      );
      request.audit('update', 'patient_policy', row.id);
      return policyView((await findPolicy(client, today, row.id)) as PolicyRow);
    },
  );

  // --- pre-authorizations ---------------------------------------------------------------------

  app.get(
    '/patients/:patientId/pre-auths',
    {
      config: { permissions: ['preauth:read'], feature: FEATURE },
      schema: {
        operationId: 'listPatientPreAuths',
        tags: ['insurance'],
        description:
          'The patient’s pre-authorization requests, newest first. `billedMinor` is worked out from the visit’s charge ledger. Audited as a read of each. Requires preauth:read and a patient the caller may read.',
        params: PatientParams,
        response: { 200: Type.Array(ref(PreAuth)), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      await requirePatient(request, request.params.patientId);
      const { rows } = await request.txClient.query<PreAuthRow>(
        `${PRE_AUTHS} where a.patient_id = $1 order by a.requested_at desc, a.id desc`,
        [request.params.patientId],
      );
      for (const row of rows) request.audit('read', 'pre_auth', row.id);
      return rows.map(preAuthView);
    },
  );

  app.get(
    '/encounters/:encounterId/pre-auths',
    {
      config: { permissions: ['preauth:read'], feature: FEATURE },
      schema: {
        operationId: 'listEncounterPreAuths',
        tags: ['insurance'],
        description:
          'The pre-authorization requests made for a visit, newest first, each with what the visit has been charged so far (`billedMinor`, from the charge ledger). Requires preauth:read and a patient the caller may read.',
        params: EncounterParams,
        response: { 200: Type.Array(ref(PreAuth)), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const id = request.params.encounterId;
      const found = isUuid(id)
        ? (
            await request.txClient.query<{ patient_id: string }>(
              'select patient_id from encounters where id = $1',
              [id],
            )
          ).rows[0]
        : undefined;
      if (!found) throw new HttpError(404, 'encounter_not_found', 'No such visit');
      await requirePatient(request, found.patient_id);
      const { rows } = await request.txClient.query<PreAuthRow>(
        `${PRE_AUTHS} where a.encounter_id = $1 order by a.requested_at desc, a.id desc`,
        [id],
      );
      for (const row of rows) request.audit('read', 'pre_auth', row.id);
      return rows.map(preAuthView);
    },
  );

  app.post(
    '/patients/:patientId/pre-auths',
    {
      config: {
        permissions: ['preauth:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createPreAuth',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Asks the payer to pre-authorize a treatment against one of the patient’s policies, in status `submitted`. The policy must be active (409 `policy_not_active`); a visit, when named, is the patient’s own (404 `encounter_not_found`). The enclosed documents are named; the files are on the patient’s record. Audited. Requires preauth:manage.',
        params: PatientParams,
        body: PreAuthCreate,
        response: { 201: ref(PreAuth), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      await requirePatient(request, request.params.patientId);
      const today = await todayAtHospital(client);
      const policy = await findPolicy(client, today, body.policyId);
      if (!policy || policy.patient_id !== request.params.patientId) {
        throw new HttpError(404, 'policy_not_found', 'No such policy');
      }
      if (policy.status !== 'active') {
        throw new HttpError(409, 'policy_not_active', 'The policy is not active');
      }
      if (body.encounterId !== undefined) {
        const visit = isUuid(body.encounterId)
          ? await client.query('select 1 from encounters where id = $1 and patient_id = $2', [
              body.encounterId,
              request.params.patientId,
            ])
          : { rows: [] };
        if (visit.rows.length === 0) {
          throw new HttpError(404, 'encounter_not_found', 'No such visit');
        }
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into pre_auths (patient_id, policy_id, encounter_id, treatment, requested_minor,
           documents, requested_by) values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning id`,
        [
          request.params.patientId,
          policy.id,
          body.encounterId ?? null,
          tidy(body.treatment),
          body.requestedMinor,
          JSON.stringify(body.documents.map(tidy)),
          userIdOf(request),
        ],
      );
      const id = (rows[0] as { id: string }).id;
      request.audit('create', 'pre_auth', id);
      return reply.status(201).send(preAuthView((await findPreAuth(client, id)) as PreAuthRow));
    },
  );

  app.post(
    '/pre-auths/:preAuthId/decision',
    {
      config: { permissions: ['preauth:manage'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'decidePreAuth',
        tags: ['insurance'],
        headers: IdempotencyHeaders,
        description:
          'Records the payer’s answer to a submitted request: approved (with the approved amount, 422 `validation_failed` without) or rejected. Once only: another answer is 409 `not_submitted`; a stale `version` is 409 `version_conflict`. Audited. Requires preauth:manage.',
        params: PreAuthParams,
        body: PreAuthDecision,
        response: { 200: ref(PreAuth), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await findPreAuth(client, request.params.preAuthId);
      if (!probe) throw preAuthGone();
      const row = (await findPreAuth(client, probe.id, true)) as PreAuthRow;
      if (row.version !== body.version) throw versionConflict();
      if (row.status !== 'submitted') throw new HttpError(409, 'not_submitted', 'Answered already');
      if (body.outcome === 'approved' && body.approvedMinor === undefined) {
        throw new HttpError(422, 'validation_failed', 'The approved amount is needed');
      }
      await client.query(
        `update pre_auths set status = $2, approved_minor = $3, reference_number = $4,
           decision_note = $5, decided_at = now(), decided_by = $6 where id = $1`,
        [
          row.id,
          body.outcome,
          body.outcome === 'approved' ? (body.approvedMinor ?? null) : null,
          body.referenceNumber === undefined ? null : tidy(body.referenceNumber),
          body.note === undefined ? null : tidy(body.note),
          userIdOf(request),
        ],
      );
      request.audit('update', 'pre_auth', row.id);
      return preAuthView((await findPreAuth(client, row.id)) as PreAuthRow);
    },
  );

  app.post(
    '/pre-auths/:preAuthId/cancel',
    {
      config: { permissions: ['preauth:manage'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'cancelPreAuth',
        tags: ['insurance'],
        headers: IdempotencyHeaders,
        description:
          'Withdraws a request that has not been answered (409 `not_submitted` otherwise). A stale `version` is 409 `version_conflict`. Audited. Requires preauth:manage.',
        params: PreAuthParams,
        body: PreAuthCancel,
        response: { 200: ref(PreAuth), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const probe = await findPreAuth(client, request.params.preAuthId);
      if (!probe) throw preAuthGone();
      const row = (await findPreAuth(client, probe.id, true)) as PreAuthRow;
      if (row.version !== request.body.version) throw versionConflict();
      if (row.status !== 'submitted') throw new HttpError(409, 'not_submitted', 'Answered already');
      await client.query(
        "update pre_auths set status = 'cancelled', decided_at = now(), decided_by = $2 where id = $1",
        [row.id, userIdOf(request)],
      );
      request.audit('update', 'pre_auth', row.id);
      return preAuthView((await findPreAuth(client, row.id)) as PreAuthRow);
    },
  );
};
