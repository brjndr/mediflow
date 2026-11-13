import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockServiceNamed } from './services';

type Schemas = components['schemas'];
type Payer = Schemas['Payer'];
type PayerPlan = Schemas['PayerPlan'];
type RateAgreement = Schemas['RateAgreement'];

const FEATURE_FLAG = 'insurance';
const READ = 'payer:read';
const MANAGE = 'payer:manage';
const KINDS = ['insurer', 'tpa', 'corporate'];
const MODES = ['all_except', 'only_listed'];
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What is stored: services by id only. Their names are read when shown. */
interface StoredPayer extends Omit<Payer, 'planCount'> {
  tenantId: string;
}
interface StoredPlan extends Omit<PayerPlan, 'services'> {
  tenantId: string;
  services: { serviceId: string; limitMinor?: number }[];
}
interface StoredAgreement extends Omit<RateAgreement, 'rates'> {
  tenantId: string;
  rates: { serviceId: string; rateMinor: number }[];
}
interface State {
  payers: StoredPayer[];
  plans: StoredPlan[];
  agreements: StoredAgreement[];
  created: number;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, string>;
}

function seed(): State {
  const H = TENANT_IDS.hospital;
  return {
    payers: [
      {
        id: 'pyr_h_star',
        tenantId: H,
        kind: 'insurer',
        code: 'STAR',
        name: 'Star Sample Insurance',
        contactName: 'Claims desk',
        phone: '+91 80 4000 1111',
        email: 'claims@star.example',
        archived: false,
        version: 1,
      },
      {
        id: 'pyr_h_medi',
        tenantId: H,
        kind: 'tpa',
        code: 'MEDI',
        name: 'MediAssist Sample TPA',
        archived: false,
        version: 1,
      },
      {
        id: 'pyr_h_acme',
        tenantId: H,
        kind: 'corporate',
        code: 'ACME',
        name: 'Acme Industries',
        contactName: 'HR benefits',
        archived: false,
        version: 1,
      },
      {
        id: 'pyr_h_old',
        tenantId: H,
        kind: 'insurer',
        code: 'OLD',
        name: 'Old Sample Assurance',
        archived: true,
        version: 2,
      },
      {
        id: 'pyr_c_care',
        tenantId: TENANT_IDS.clinic,
        kind: 'insurer',
        code: 'CARE',
        name: 'Clinic Care Cover',
        archived: false,
        version: 1,
      },
    ],
    plans: [
      {
        id: 'pln_h_gold',
        tenantId: H,
        payerId: 'pyr_h_star',
        code: 'GOLD',
        name: 'Gold family floater',
        coverageMode: 'all_except',
        copayPercent: 10,
        sumInsuredMinor: 50000000,
        roomRentLimitMinor: 500000,
        preAuthRequired: true,
        minAge: 0,
        maxAge: 65,
        waitingPeriodDays: 30,
        services: [],
        archived: false,
        version: 1,
      },
    ],
    agreements: [
      {
        id: 'agr_h_2026',
        tenantId: H,
        payerId: 'pyr_h_star',
        name: 'Star network rates 2026',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-12-31',
        discountBp: 1000,
        rates: [],
        version: 1,
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

function page<T extends { id: string }>(rows: T[], query: URLSearchParams) {
  const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100);
  const cursor = query.get('cursor');
  const start = cursor ? rows.findIndex((one) => one.id === cursor) : 0;
  if (start < 0) return undefined;
  return {
    items: rows.slice(start, start + limit),
    nextCursor: rows[start + limit]?.id ?? null,
    total: rows.length,
  };
}

const payerView = ({ tenantId, ...payer }: StoredPayer): Payer => ({
  ...payer,
  tenantId,
  planCount: state.plans.filter(
    (plan) => plan.payerId === payer.id && plan.tenantId === tenantId && !plan.archived,
  ).length,
});

const planView = ({ tenantId, services, ...plan }: StoredPlan): PayerPlan => ({
  ...plan,
  services: services.map((one) => ({
    ...one,
    serviceName: mockServiceNamed(tenantId, undefined, one.serviceId)?.name ?? '',
  })),
});

const agreementView = ({ tenantId, rates, ...agreement }: StoredAgreement): RateAgreement => ({
  ...agreement,
  rates: rates.map((rate) => ({
    ...rate,
    serviceName: mockServiceNamed(tenantId, undefined, rate.serviceId)?.name ?? '',
  })),
});

const ownPayer = (tenantId: string, id: unknown) =>
  state.payers.find((one) => one.id === id && one.tenantId === tenantId);

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.trim().length <= max;
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const todayUtc = () => new Date().toISOString().slice(0, 10);

type Body = Record<string, unknown>;
const readBody = async (request: Request) =>
  (await request.json().catch(() => null)) as Body | null;

/** The plan terms of a body, or undefined when they are not valid. Optional limits may be absent. */
function planTerms(tenantId: string, body: Body, partial: boolean) {
  const terms: Partial<StoredPlan> = {};
  const has = (name: string) => body[name] !== undefined;
  if (!partial || has('name')) {
    if (!isText(body.name, 100)) return undefined;
    terms.name = body.name.trim();
  }
  if (!partial || has('coverageMode')) {
    if (!MODES.includes(String(body.coverageMode))) return undefined;
    terms.coverageMode = body.coverageMode as StoredPlan['coverageMode'];
  }
  if (!partial || has('copayPercent')) {
    if (!isInt(body.copayPercent, 0, 100)) return undefined;
    terms.copayPercent = body.copayPercent;
  }
  if (!partial || has('preAuthRequired')) {
    if (typeof body.preAuthRequired !== 'boolean') return undefined;
    terms.preAuthRequired = body.preAuthRequired;
  }
  for (const [name, max] of [
    ['sumInsuredMinor', 1e12],
    ['roomRentLimitMinor', 1e12],
    ['minAge', 120],
    ['maxAge', 120],
    ['waitingPeriodDays', 3650],
  ] as const) {
    if (body[name] === undefined) continue;
    if (!isInt(body[name], 0, max)) return undefined;
    terms[name] = body[name];
  }
  if (!partial || has('services')) {
    if (!Array.isArray(body.services) || body.services.length > 500) return undefined;
    const services: StoredPlan['services'] = [];
    for (const one of body.services as Body[]) {
      if (typeof one?.serviceId !== 'string') return undefined;
      if (one.limitMinor !== undefined && !isInt(one.limitMinor, 0, 1e12)) return undefined;
      if (!mockServiceNamed(tenantId, undefined, one.serviceId)) return undefined;
      services.push({
        serviceId: one.serviceId,
        ...(one.limitMinor !== undefined ? { limitMinor: one.limitMinor as number } : {}),
      });
    }
    terms.services = services;
  }
  return terms;
}

export const insuranceHandlers = [
  http.get('*/api/payers', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const q = (query.get('q') ?? '').trim().toLowerCase();
    const kind = query.get('kind');
    const archived = query.get('archived') === 'true';
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const rows = state.payers
      .filter(
        (one) =>
          one.tenantId === access.tenantId &&
          one.archived === archived &&
          (!kind || one.kind === kind) &&
          (!q || one.name.toLowerCase().includes(q) || one.code.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const found = page(rows, query);
    if (!found) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({ ...found, items: found.items.map(payerView) });
  }),

  http.post('*/api/payers', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body = await readBody(request);
    if (
      !body ||
      !KINDS.includes(String(body.kind)) ||
      !isText(body.code, 20) ||
      !CODE.test(body.code.trim()) ||
      !isText(body.name, 100)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const replyKey = `${access.tenantId}:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      const code = body.code.trim();
      if (
        state.payers.some(
          (one) =>
            one.tenantId === access.tenantId && one.code.toLowerCase() === code.toLowerCase(),
        )
      ) {
        return error(409, 'duplicate_code', 'That code is used already');
      }
      state.created += 1;
      id = `pyr_mock_${state.created}`;
      state.replies.set(replyKey, id);
      const text = (name: string) =>
        typeof body[name] === 'string' && body[name].trim() !== ''
          ? { [name]: body[name].trim() }
          : {};
      state.payers.push({
        id,
        tenantId: access.tenantId,
        kind: body.kind as Payer['kind'],
        code,
        name: body.name.trim(),
        ...text('contactName'),
        ...text('phone'),
        ...text('email'),
        ...text('address'),
        archived: false,
        version: 1,
      });
    }
    const stored = state.payers.find((one) => one.id === id) as StoredPayer;
    return HttpResponse.json(payerView(stored), { status: 201 });
  }),

  http.get('*/api/payers/:payerId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const payer = ownPayer(access.tenantId, params.payerId);
    if (!payer) return error(404, 'not_found', 'No such organisation');
    return HttpResponse.json({
      payer: payerView(payer),
      plans: state.plans
        .filter((one) => one.payerId === payer.id && one.tenantId === access.tenantId)
        .map(planView),
      agreements: state.agreements
        .filter((one) => one.payerId === payer.id && one.tenantId === access.tenantId)
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
        .map(agreementView),
    });
  }),

  http.patch('*/api/payers/:payerId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const payer = ownPayer(access.tenantId, params.payerId);
    if (!payer) return error(404, 'not_found', 'No such organisation');
    const body = await readBody(request);
    if (!body || !isInt(body.version, 1, 1e9)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (body.name !== undefined && !isText(body.name, 100)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (body.version !== payer.version) {
      return error(409, 'version_conflict', 'Changed by someone else');
    }
    if (body.name !== undefined) payer.name = String(body.name).trim();
    for (const name of ['contactName', 'phone', 'email', 'address'] as const) {
      const value = body[name];
      if (value === undefined) continue;
      if (value === null) delete payer[name];
      else if (typeof value === 'string' && value.trim() !== '') payer[name] = value.trim();
      else return error(400, 'validation_failed', 'The request is not valid');
    }
    if (typeof body.archived === 'boolean') payer.archived = body.archived;
    payer.version += 1;
    return HttpResponse.json(payerView(payer));
  }),

  http.post('*/api/payers/:payerId/plans', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const payer = ownPayer(access.tenantId, params.payerId);
    if (!payer) return error(404, 'not_found', 'No such organisation');
    const body = await readBody(request);
    const terms = body && planTerms(access.tenantId, body, false);
    if (!body || !terms || !isText(body.code, 20) || !CODE.test(body.code.trim())) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (payer.archived) return error(409, 'payer_archived', 'The organisation is archived');
    const replyKey = `${access.tenantId}:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      const code = body.code.trim();
      if (
        state.plans.some(
          (one) => one.payerId === payer.id && one.code.toLowerCase() === code.toLowerCase(),
        )
      ) {
        return error(409, 'duplicate_code', 'That code is used already');
      }
      state.created += 1;
      id = `pln_mock_${state.created}`;
      state.replies.set(replyKey, id);
      state.plans.push({
        ...(terms as StoredPlan),
        id,
        tenantId: access.tenantId,
        payerId: payer.id,
        code,
        archived: false,
        version: 1,
      });
    }
    const stored = state.plans.find((one) => one.id === id) as StoredPlan;
    return HttpResponse.json(planView(stored), { status: 201 });
  }),

  http.patch('*/api/payer-plans/:planId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const plan = state.plans.find(
      (one) => one.id === params.planId && one.tenantId === access.tenantId,
    );
    if (!plan) return error(404, 'not_found', 'No such plan');
    const body = await readBody(request);
    if (!body || !isInt(body.version, 1, 1e9)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const terms = planTerms(access.tenantId, body, true);
    if (!terms) return error(400, 'validation_failed', 'The request is not valid');
    if (body.version !== plan.version) {
      return error(409, 'version_conflict', 'Changed by someone else');
    }
    // Terms sent replace the old ones, including a limit now left out.
    if (Object.keys(terms).length > 0) {
      for (const name of [
        'sumInsuredMinor',
        'roomRentLimitMinor',
        'minAge',
        'maxAge',
        'waitingPeriodDays',
      ] as const) {
        delete plan[name];
      }
    }
    Object.assign(plan, terms);
    if (typeof body.archived === 'boolean') plan.archived = body.archived;
    plan.version += 1;
    return HttpResponse.json(planView(plan));
  }),

  http.post('*/api/payers/:payerId/rate-agreements', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const payer = ownPayer(access.tenantId, params.payerId);
    if (!payer) return error(404, 'not_found', 'No such organisation');
    const body = await readBody(request);
    if (
      !body ||
      !isText(body.name, 100) ||
      !isDate(body.effectiveFrom) ||
      (body.effectiveTo !== undefined && !isDate(body.effectiveTo)) ||
      !isInt(body.discountBp, 0, 10000) ||
      !Array.isArray(body.rates) ||
      body.rates.length > 500
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const rates: StoredAgreement['rates'] = [];
    for (const rate of body.rates as Body[]) {
      if (
        typeof rate?.serviceId !== 'string' ||
        !isInt(rate.rateMinor, 0, 1e12) ||
        !mockServiceNamed(access.tenantId, undefined, rate.serviceId)
      ) {
        return error(400, 'validation_failed', 'The request is not valid');
      }
      rates.push({ serviceId: rate.serviceId, rateMinor: rate.rateMinor });
    }
    const from = body.effectiveFrom;
    const to = typeof body.effectiveTo === 'string' ? body.effectiveTo : undefined;
    if (to !== undefined && to < from) {
      return error(400, 'validation_failed', 'The last day is before the first');
    }
    if (payer.archived) return error(409, 'payer_archived', 'The organisation is archived');
    const replyKey = `${access.tenantId}:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      if (from < todayUtc()) return error(422, 'starts_in_past', 'Starts in the past');
      // Periods are closed ranges; no end means open-ended.
      const overlaps = state.agreements.some(
        (one) =>
          one.payerId === payer.id &&
          one.tenantId === access.tenantId &&
          (to === undefined || one.effectiveFrom <= to) &&
          (one.effectiveTo === undefined || one.effectiveTo >= from),
      );
      if (overlaps) return error(409, 'agreement_overlap', 'Overlaps another agreement');
      state.created += 1;
      id = `agr_mock_${state.created}`;
      state.replies.set(replyKey, id);
      state.agreements.push({
        id,
        tenantId: access.tenantId,
        payerId: payer.id,
        name: body.name.trim(),
        effectiveFrom: from,
        ...(to !== undefined ? { effectiveTo: to } : {}),
        discountBp: body.discountBp,
        rates,
        version: 1,
      });
    }
    const stored = state.agreements.find((one) => one.id === id) as StoredAgreement;
    return HttpResponse.json(agreementView(stored), { status: 201 });
  }),

  http.patch('*/api/rate-agreements/:agreementId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const agreement = state.agreements.find(
      (one) => one.id === params.agreementId && one.tenantId === access.tenantId,
    );
    if (!agreement) return error(404, 'not_found', 'No such agreement');
    const body = await readBody(request);
    if (
      !body ||
      !isInt(body.version, 1, 1e9) ||
      (body.effectiveTo !== null && !isDate(body.effectiveTo))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (body.version !== agreement.version) {
      return error(409, 'version_conflict', 'Changed by someone else');
    }
    const to = body.effectiveTo as string | null;
    if (to !== null && to < agreement.effectiveFrom) {
      return error(422, 'validation_failed', 'The last day is before the first');
    }
    // Ending later, or not at all, must not run into the next agreement of the payer.
    const clash = state.agreements.some(
      (one) =>
        one.id !== agreement.id &&
        one.payerId === agreement.payerId &&
        one.tenantId === access.tenantId &&
        one.effectiveFrom > agreement.effectiveFrom &&
        (to === null || one.effectiveFrom <= to),
    );
    if (clash) return error(409, 'agreement_overlap', 'Overlaps another agreement');
    if (to === null) delete agreement.effectiveTo;
    else agreement.effectiveTo = to;
    agreement.version += 1;
    return HttpResponse.json(agreementView(agreement));
  }),
];

/** A plan with its organisation, for the policies of a patient (policy capture, IN-02). */
export function mockPlanWithPayer(tenantId: string, planId: unknown) {
  const plan = state.plans.find((one) => one.id === planId && one.tenantId === tenantId);
  const payer = plan && state.payers.find((one) => one.id === plan.payerId);
  if (!plan || !payer) return undefined;
  return {
    planId: plan.id,
    planName: plan.name,
    payerId: payer.id,
    payerName: payer.name,
    archived: plan.archived || payer.archived,
    preAuthRequired: plan.preAuthRequired,
  };
}
