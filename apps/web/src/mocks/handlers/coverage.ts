import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockPlanWithPayer } from './insurance';
import { mockPatient } from './patients';

type Schemas = components['schemas'];
type Policy = Schemas['PatientPolicy'];
type PreAuth = Schemas['PreAuth'];

const FEATURE_FLAG = 'insurance';
const RELATIONS = ['self', 'spouse', 'child', 'parent', 'other'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAIN = /^[^<>]*$/;

type Stored<T> = T & { tenantId: string; ended?: boolean };
interface State {
  policies: Stored<Omit<Policy, 'status'>>[];
  preAuths: Stored<PreAuth>[];
  created: number;
  replies: Map<string, string>;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * The sample hospital's first patient has a Gold policy and, for the open visit `enc_h_1`, an
 * approved pre-authorization that the bill is already at 84% of (near the limit). The clinic has
 * one policy of its own, to show that nothing crosses between hospitals.
 */
function seed(): State {
  const H = TENANT_IDS.hospital;
  return {
    policies: [
      {
        id: 'pol_h_1',
        tenantId: H,
        patientId: 'pth_00001',
        payerId: 'pyr_h_star',
        payerName: 'Star Sample Insurance',
        planId: 'pln_h_gold',
        planName: 'Gold family floater',
        policyNumber: 'STAR-2026-0001',
        memberId: 'M-1001',
        holderName: 'Sample Holder',
        relationship: 'self',
        validFrom: '2026-01-01',
        validTo: '2027-12-31',
        preAuthRequired: true,
        version: 1,
      },
      {
        id: 'pol_c_1',
        tenantId: TENANT_IDS.clinic,
        patientId: 'ptc_00001',
        payerId: 'pyr_c_care',
        payerName: 'Clinic Care Cover',
        planId: 'pln_c_basic',
        planName: 'Basic',
        policyNumber: 'CARE-77',
        holderName: 'Clinic Holder',
        relationship: 'self',
        validFrom: '2026-01-01',
        preAuthRequired: false,
        version: 1,
      },
    ],
    preAuths: [
      {
        id: 'pa_h_1',
        tenantId: H,
        patientId: 'pth_00001',
        policyId: 'pol_h_1',
        payerName: 'Star Sample Insurance',
        planName: 'Gold family floater',
        policyNumber: 'STAR-2026-0001',
        encounterId: 'enc_h_1',
        treatment: 'Planned knee replacement, 5 days in a semi-private room',
        requestedMinor: 5500000,
        approvedMinor: 5000000,
        billedMinor: 4200000,
        status: 'approved',
        referenceNumber: 'PA-5521',
        documents: ['Admission note', 'MRI report'],
        requestedAt: minutesAgo(3 * 24 * 60),
        decidedAt: minutesAgo(2 * 24 * 60),
        version: 2,
      },
    ],
    created: 0,
    replies: new Map(),
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function policyView({
  tenantId: _tenant,
  ended,
  ...policy
}: Stored<Omit<Policy, 'status'>>): Policy {
  void _tenant;
  const status: Policy['status'] = ended
    ? 'ended'
    : policy.validTo !== undefined && policy.validTo < todayUtc()
      ? 'expired'
      : 'active';
  return { ...policy, status };
}

function preAuthView({ tenantId: _tenant, ...item }: Stored<PreAuth>): PreAuth {
  void _tenant;
  return item;
}

type Body = Record<string, unknown>;
async function readBody(request: Request): Promise<Body | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Body)
      : undefined;
  } catch {
    return undefined;
  }
}
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length >= 1 && value.length <= max && PLAIN.test(value);
const isOptionalText = (value: unknown, max: number) => value === undefined || isText(value, max);
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isDate = (value: unknown): value is string => typeof value === 'string' && DATE.test(value);

const bad = () => error(400, 'validation_failed', 'The request is not valid');

export const coverageHandlers = [
  http.get('*/api/patients/:patientId/policies', ({ request, params }) => {
    const access = authorize(request, { permission: 'policy:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) return error(404, 'not_found', 'No such patient');
    return HttpResponse.json(
      state.policies
        .filter((one) => one.tenantId === access.tenantId && one.patientId === patientId)
        .reverse()
        .map(policyView),
    );
  }),

  http.post('*/api/patients/:patientId/policies', async ({ request, params }) => {
    const access = authorize(request, { permission: 'policy:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) return error(404, 'not_found', 'No such patient');
    const body = await readBody(request);
    if (
      !body ||
      typeof body.planId !== 'string' ||
      !isText(body.policyNumber, 40) ||
      !isOptionalText(body.memberId, 40) ||
      !isText(body.holderName, 100) ||
      !RELATIONS.includes(String(body.relationship)) ||
      !isDate(body.validFrom) ||
      (body.validTo !== undefined && !isDate(body.validTo))
    ) {
      return bad();
    }
    if (body.validTo !== undefined && String(body.validTo) < body.validFrom) {
      return error(422, 'validation_failed', 'The last day is before the first');
    }
    const plan = mockPlanWithPayer(access.tenantId, body.planId);
    if (!plan) return error(404, 'not_found', 'No such plan');
    if (plan.archived) return error(409, 'plan_archived', 'The plan is archived');
    const replyKey = `${access.tenantId}:policy:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      const number = body.policyNumber.trim();
      const duplicate = state.policies.some(
        (one) =>
          one.tenantId === access.tenantId &&
          one.patientId === patientId &&
          one.planId === plan.planId &&
          one.policyNumber === number &&
          !one.ended,
      );
      if (duplicate) return error(409, 'duplicate_policy', 'Already on the record');
      state.created += 1;
      id = `pol_mock_${state.created}`;
      state.replies.set(replyKey, id);
      state.policies.push({
        id,
        tenantId: access.tenantId,
        patientId,
        payerId: plan.payerId,
        payerName: plan.payerName,
        planId: plan.planId,
        planName: plan.planName,
        policyNumber: number,
        ...(typeof body.memberId === 'string' ? { memberId: body.memberId.trim() } : {}),
        holderName: body.holderName.trim(),
        relationship: body.relationship as Policy['relationship'],
        validFrom: body.validFrom,
        ...(typeof body.validTo === 'string' ? { validTo: body.validTo } : {}),
        preAuthRequired: plan.preAuthRequired,
        version: 1,
      });
    }
    const stored = state.policies.find((one) => one.id === id);
    return HttpResponse.json(policyView(stored as NonNullable<typeof stored>), { status: 201 });
  }),

  http.post('*/api/patient-policies/:policyId/end', async ({ request, params }) => {
    const access = authorize(request, { permission: 'policy:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const policy = state.policies.find(
      (one) => one.id === params.policyId && one.tenantId === access.tenantId,
    );
    if (!policy) return error(404, 'not_found', 'No such policy');
    const body = await readBody(request);
    if (!body || !isInt(body.version, 1, 1e9)) return bad();
    if (body.version !== policy.version) return error(409, 'version_conflict', 'Changed already');
    policy.ended = true;
    policy.version += 1;
    return HttpResponse.json(policyView(policy));
  }),

  http.get('*/api/patients/:patientId/pre-auths', ({ request, params }) => {
    const access = authorize(request, { permission: 'preauth:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) return error(404, 'not_found', 'No such patient');
    return HttpResponse.json(
      state.preAuths
        .filter((one) => one.tenantId === access.tenantId && one.patientId === patientId)
        .reverse()
        .map(preAuthView),
    );
  }),

  http.get('*/api/encounters/:encounterId/pre-auths', ({ request, params }) => {
    const access = authorize(request, { permission: 'preauth:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    return HttpResponse.json(
      state.preAuths
        .filter((one) => one.tenantId === access.tenantId && one.encounterId === params.encounterId)
        .reverse()
        .map(preAuthView),
    );
  }),

  http.post('*/api/patients/:patientId/pre-auths', async ({ request, params }) => {
    const access = authorize(request, { permission: 'preauth:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) return error(404, 'not_found', 'No such patient');
    const body = await readBody(request);
    if (
      !body ||
      typeof body.policyId !== 'string' ||
      !isText(body.treatment, 300) ||
      !isInt(body.requestedMinor, 0, 1e12) ||
      !Array.isArray(body.documents) ||
      body.documents.length > 20 ||
      !body.documents.every((name) => isText(name, 100)) ||
      (body.encounterId !== undefined && typeof body.encounterId !== 'string')
    ) {
      return bad();
    }
    const policy = state.policies.find(
      (one) =>
        one.id === body.policyId && one.tenantId === access.tenantId && one.patientId === patientId,
    );
    if (!policy) return error(404, 'not_found', 'No such policy');
    if (policyView(policy).status !== 'active') {
      return error(409, 'policy_not_active', 'The policy is not active');
    }
    const replyKey = `${access.tenantId}:preauth:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      state.created += 1;
      id = `pa_mock_${state.created}`;
      state.replies.set(replyKey, id);
      state.preAuths.push({
        id,
        tenantId: access.tenantId,
        patientId,
        policyId: policy.id,
        payerName: policy.payerName,
        planName: policy.planName,
        policyNumber: policy.policyNumber,
        ...(typeof body.encounterId === 'string' ? { encounterId: body.encounterId } : {}),
        treatment: body.treatment.trim(),
        requestedMinor: body.requestedMinor,
        billedMinor: 0,
        status: 'submitted',
        documents: (body.documents as string[]).map((name) => name.trim()),
        requestedAt: new Date().toISOString(),
        version: 1,
      });
    }
    const stored = state.preAuths.find((one) => one.id === id);
    return HttpResponse.json(preAuthView(stored as NonNullable<typeof stored>), { status: 201 });
  }),

  http.post('*/api/pre-auths/:preAuthId/decision', async ({ request, params }) => {
    const access = authorize(request, { permission: 'preauth:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const item = state.preAuths.find(
      (one) => one.id === params.preAuthId && one.tenantId === access.tenantId,
    );
    if (!item) return error(404, 'not_found', 'No such request');
    const body = await readBody(request);
    if (
      !body ||
      !isInt(body.version, 1, 1e9) ||
      (body.outcome !== 'approved' && body.outcome !== 'rejected') ||
      (body.approvedMinor !== undefined && !isInt(body.approvedMinor, 0, 1e12)) ||
      !isOptionalText(body.referenceNumber, 60) ||
      !isOptionalText(body.note, 300)
    ) {
      return bad();
    }
    if (body.version !== item.version) return error(409, 'version_conflict', 'Changed already');
    if (item.status !== 'submitted') return error(409, 'not_submitted', 'Already answered');
    if (body.outcome === 'approved' && body.approvedMinor === undefined) {
      return error(422, 'validation_failed', 'The approved amount is needed');
    }
    item.status = body.outcome;
    if (body.outcome === 'approved') item.approvedMinor = body.approvedMinor as number;
    if (typeof body.referenceNumber === 'string')
      item.referenceNumber = body.referenceNumber.trim();
    if (typeof body.note === 'string') item.decisionNote = body.note.trim();
    item.decidedAt = new Date().toISOString();
    item.version += 1;
    return HttpResponse.json(preAuthView(item));
  }),

  http.post('*/api/pre-auths/:preAuthId/cancel', async ({ request, params }) => {
    const access = authorize(request, { permission: 'preauth:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const item = state.preAuths.find(
      (one) => one.id === params.preAuthId && one.tenantId === access.tenantId,
    );
    if (!item) return error(404, 'not_found', 'No such request');
    const body = await readBody(request);
    if (!body || !isInt(body.version, 1, 1e9)) return bad();
    if (body.version !== item.version) return error(409, 'version_conflict', 'Changed already');
    if (item.status !== 'submitted') return error(409, 'not_submitted', 'Already answered');
    item.status = 'cancelled';
    item.version += 1;
    return HttpResponse.json(preAuthView(item));
  }),
];

/** The patient's newest policy that is active today, for the split of a visit (IN-03). */
export function mockActivePolicy(tenantId: string, patientId: string) {
  const found = state.policies
    .filter((one) => one.tenantId === tenantId && one.patientId === patientId)
    .reverse()
    .find((one) => policyView(one).status === 'active');
  return found && policyView(found);
}
