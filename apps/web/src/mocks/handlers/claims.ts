import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockEncounter } from './clinical';
import { mockActivePolicy } from './coverage';
import { mockSplit } from './coverage-split';

type Schemas = components['schemas'];
type Claim = Schemas['Claim'];
type Status = Schemas['ClaimStatus'];
type Action = Schemas['ClaimActionKind'];
type Event = Schemas['ClaimEvent'];

const FEATURE_FLAG = 'insurance';
const PLAIN = /^[^<>]*$/;
const DAY_MS = 86_400_000;
const AGING_LIMITS = [30, 60, 90];

type Stored = Omit<Claim, 'outstandingMinor'> & { tenantId: string; events: Event[] };

/**
 * The claim state machine, as the API will enforce it: what can be done in each state and where
 * it leads. A reply answers a query and puts the claim back to the payer; a rejected claim and a
 * claim short-paid can be written off; every other state ends the claim.
 */
export const CLAIM_TRANSITIONS: Record<Status, Partial<Record<Action, Status>>> = {
  draft: { submit: 'submitted', cancel: 'cancelled' },
  submitted: { raise_query: 'query', approve: 'approved', reject: 'rejected' },
  query: { reply: 'submitted', cancel: 'cancelled' },
  approved: { settle: 'settled' },
  rejected: { write_off: 'written_off' },
  settled: { write_off: 'written_off' },
  written_off: {},
  cancelled: {},
};

interface State {
  claims: Stored[];
  created: number;
  replies: Map<string, string>;
}

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

function claim(
  tenantId: string,
  n: number,
  fields: Partial<Stored> &
    Pick<Stored, 'status' | 'claimedMinor' | 'patientId' | 'payerId' | 'payerName'>,
  ageDays: number,
): Stored {
  return {
    id: `clm_${tenantId === TENANT_IDS.hospital ? 'h' : 'c'}_${n}`,
    tenantId,
    number: `CLM-${String(n).padStart(6, '0')}`,
    encounterId: `enc_seed_${n}`,
    policyId: tenantId === TENANT_IDS.hospital ? 'pol_h_1' : 'pol_c_1',
    policyNumber: 'STAR-2026-0001',
    receivedMinor: 0,
    writtenOffMinor: 0,
    documents: ['Discharge summary', 'Final bill'],
    createdAt: daysAgo(ageDays + 1),
    submittedAt: daysAgo(ageDays),
    events: [
      { at: daysAgo(ageDays + 1), action: 'create', toStatus: 'draft' },
      { at: daysAgo(ageDays), action: 'submit', toStatus: 'submitted' },
    ],
    version: 1,
    ...fields,
  };
}

/**
 * The sample hospital has claims in four stages, aged differently, so the aging view has more
 * than one column. The clinic has one of its own, to show that nothing crosses between hospitals.
 */
function seed(): State {
  const H = TENANT_IDS.hospital;
  const star = { payerId: 'pyr_h_star', payerName: 'Star Sample Insurance' };
  const medi = { payerId: 'pyr_h_medi', payerName: 'MediAssist Sample TPA' };
  return {
    claims: [
      claim(
        H,
        1,
        { ...star, patientId: 'pth_00001', status: 'submitted', claimedMinor: 1200000 },
        70,
      ),
      claim(
        H,
        2,
        {
          ...star,
          patientId: 'pth_00002',
          status: 'approved',
          claimedMinor: 900000,
          approvedMinor: 800000,
          version: 2,
        },
        20,
      ),
      claim(
        H,
        3,
        {
          ...medi,
          patientId: 'pth_00001',
          status: 'query',
          claimedMinor: 450000,
          openQuery: 'Please send the operation notes.',
          version: 2,
        },
        35,
      ),
      claim(
        H,
        4,
        {
          ...medi,
          patientId: 'pth_00002',
          status: 'settled',
          claimedMinor: 600000,
          approvedMinor: 600000,
          receivedMinor: 500000,
          version: 3,
        },
        100,
      ),
      claim(
        TENANT_IDS.clinic,
        1,
        {
          payerId: 'pyr_c_care',
          payerName: 'Clinic Care Cover',
          patientId: 'ptc_00001',
          status: 'submitted',
          claimedMinor: 77700,
        },
        5,
      ),
    ],
    created: 4,
    replies: new Map(),
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** Claimed less received and written off, for a claim that is in play; nothing before or after. */
function outstanding(item: Stored): number {
  if (item.status === 'draft' || item.status === 'cancelled' || item.status === 'written_off') {
    return 0;
  }
  return Math.max(item.claimedMinor - item.receivedMinor - item.writtenOffMinor, 0);
}

function allowed(item: Stored): Action[] {
  return (Object.keys(CLAIM_TRANSITIONS[item.status]) as Action[]).filter(
    // A claim paid in full has nothing left to give up.
    (action) => action !== 'write_off' || outstanding(item) > 0,
  );
}

function view({ tenantId: _tenant, events: _events, ...item }: Stored): Claim {
  void _tenant;
  void _events;
  return { ...item, outstandingMinor: outstanding({ ...item, tenantId: '', events: [] }) };
}

function detail(item: Stored) {
  return { ...view(item), events: [...item.events].reverse(), allowedActions: allowed(item) };
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length >= 1 && value.length <= max && PLAIN.test(value);
const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 20 && value.every((one) => isText(one, 100));
const isMinor = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 2_000_000_000;

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
const bad = () => error(400, 'validation_failed', 'The request is not valid');

/** The open claim of a visit, if any: a visit has one claim in play at a time. */
function openClaimOf(tenantId: string, encounterId: string) {
  return state.claims.find(
    (one) =>
      one.tenantId === tenantId &&
      one.encounterId === encounterId &&
      one.status !== 'cancelled' &&
      one.status !== 'written_off',
  );
}

export const claimHandlers = [
  http.get('*/api/claims', ({ request }) => {
    const access = authorize(request, { permission: 'claim:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    if (status !== null && !Object.hasOwn(CLAIM_TRANSITIONS, status)) return bad();
    const rows = state.claims
      .filter((one) => one.tenantId === access.tenantId && (!status || one.status === status))
      .reverse();
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
    const cursor = url.searchParams.get('cursor');
    const start = cursor ? rows.findIndex((one) => one.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const page = rows.slice(start, start + limit);
    return HttpResponse.json({
      items: page.map(view),
      nextCursor: start + limit < rows.length ? (rows[start + limit]?.id ?? null) : null,
      total: rows.length,
    });
  }),

  http.get('*/api/claims/aging', ({ request }) => {
    const access = authorize(request, { permission: 'claim:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const now = Date.now();
    const rows = new Map<
      string,
      {
        payerId: string;
        payerName: string;
        claims: number;
        buckets: number[];
        outstandingMinor: number;
      }
    >();
    const totals = { claims: 0, buckets: [0, 0, 0, 0], outstandingMinor: 0 };
    for (const item of state.claims) {
      const left = outstanding(item);
      if (item.tenantId !== access.tenantId || left === 0 || item.submittedAt === undefined) {
        continue;
      }
      const age = Math.floor((now - Date.parse(item.submittedAt)) / DAY_MS);
      let bucket = AGING_LIMITS.findIndex((limit) => age <= limit);
      if (bucket < 0) bucket = 3;
      const row = rows.get(item.payerId) ?? {
        payerId: item.payerId,
        payerName: item.payerName,
        claims: 0,
        buckets: [0, 0, 0, 0],
        outstandingMinor: 0,
      };
      for (const into of [row, totals]) {
        into.claims += 1;
        into.buckets[bucket] = (into.buckets[bucket] ?? 0) + left;
        into.outstandingMinor += left;
      }
      rows.set(item.payerId, row);
    }
    return HttpResponse.json({
      asOf: new Date(now).toISOString(),
      rows: [...rows.values()].sort((a, b) => b.outstandingMinor - a.outstandingMinor),
      totals,
    });
  }),

  http.get('*/api/claims/:claimId', ({ request, params }) => {
    const access = authorize(request, { permission: 'claim:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = state.claims.find(
      (one) => one.tenantId === access.tenantId && one.id === params.claimId,
    );
    if (!found) return error(404, 'not_found', 'No such claim');
    return HttpResponse.json(detail(found));
  }),

  http.post('*/api/encounters/:encounterId/claims', async ({ request, params }) => {
    const access = authorize(request, { permission: 'claim:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body = await readBody(request);
    if (!body || !isNames(body.documents) || (body.note !== undefined && !isText(body.note, 500))) {
      return bad();
    }
    const encounterId = String(params.encounterId);
    const visit = mockEncounter(encounterId);
    if (!visit || visit.tenantId !== access.tenantId)
      return error(404, 'not_found', 'No such visit');
    const replyKey = `${access.tenantId}:${key}`;
    const replied = state.replies.get(replyKey);
    const earlier = replied ? state.claims.find((one) => one.id === replied) : undefined;
    if (earlier) return HttpResponse.json(detail(earlier), { status: 201 });
    const split = mockSplit(access.tenantId, encounterId);
    if (!split) return error(404, 'not_found', 'No active policy for this visit');
    if (openClaimOf(access.tenantId, encounterId)) {
      return error(409, 'claim_exists', 'This visit already has a claim');
    }
    if (split.payerMinor <= 0) return error(422, 'nothing_to_claim', 'The payer owes nothing');
    state.created += 1;
    const id = `clm_mock_${state.created}`;
    const policy = mockActivePolicy(access.tenantId, visit.patientId);
    if (!policy) return error(404, 'not_found', 'No active policy for this visit');
    state.replies.set(replyKey, id);
    state.claims.push({
      id,
      tenantId: access.tenantId,
      number: `CLM-${String(state.created).padStart(6, '0')}`,
      patientId: visit.patientId,
      encounterId,
      policyId: split.policyId,
      payerId: policy.payerId,
      payerName: split.payerName,
      policyNumber: policy.policyNumber,
      claimedMinor: split.payerMinor,
      receivedMinor: 0,
      writtenOffMinor: 0,
      status: 'draft',
      documents: body.documents.map((one) => one.trim()),
      createdAt: new Date().toISOString(),
      events: [
        {
          at: new Date().toISOString(),
          action: 'create',
          toStatus: 'draft',
          ...(typeof body.note === 'string' ? { note: body.note.trim() } : {}),
        },
      ],
      version: 1,
    });
    const made = state.claims[state.claims.length - 1];
    return HttpResponse.json(detail(made as Stored), { status: 201 });
  }),

  http.post('*/api/claims/:claimId/actions', async ({ request, params }) => {
    const access = authorize(request, { permission: 'claim:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (
      !body ||
      !isMinor(body.version, 1) ||
      typeof body.action !== 'string' ||
      !Object.hasOwn(ALL_ACTIONS, body.action) ||
      (body.note !== undefined && !isText(body.note, 500)) ||
      (body.referenceNumber !== undefined && !isText(body.referenceNumber, 60)) ||
      (body.documents !== undefined && !isNames(body.documents))
    ) {
      return bad();
    }
    const action = body.action as Action;
    if (action === 'write_off') {
      const writeOff = authorize(request, {
        permission: 'claim:writeoff',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in writeOff) return writeOff.denied;
    }
    const found = state.claims.find(
      (one) => one.tenantId === access.tenantId && one.id === params.claimId,
    );
    if (!found) return error(404, 'not_found', 'No such claim');
    if (found.version !== body.version) {
      return error(409, 'version_conflict', 'The claim was changed by someone else');
    }
    const next = CLAIM_TRANSITIONS[found.status][action];
    if (!next || !allowed(found).includes(action)) {
      return error(409, 'invalid_transition', 'The claim cannot be moved this way now');
    }
    const note = typeof body.note === 'string' ? body.note.trim() : undefined;
    if (['raise_query', 'reply', 'reject', 'write_off'].includes(action) && !note) {
      return error(422, 'validation_failed', 'A note is required');
    }
    let amountMinor: number | undefined;
    if (action === 'approve') {
      if (!isMinor(body.approvedMinor, 0) || body.approvedMinor > found.claimedMinor) {
        return error(422, 'validation_failed', 'The approved amount is more than was claimed');
      }
      amountMinor = body.approvedMinor;
      found.approvedMinor = amountMinor;
    }
    if (action === 'settle') {
      const approved = found.approvedMinor ?? 0;
      if (!isMinor(body.receivedMinor, 1) || body.receivedMinor > approved) {
        return error(422, 'validation_failed', 'The payment is more than was approved');
      }
      amountMinor = body.receivedMinor;
      found.receivedMinor += amountMinor;
    }
    if (action === 'write_off') {
      amountMinor = outstanding(found);
      found.writtenOffMinor += amountMinor;
    }
    if (action === 'submit') found.submittedAt = new Date().toISOString();
    if (action === 'raise_query') found.openQuery = note;
    if (action === 'reply') {
      delete found.openQuery;
      if (Array.isArray(body.documents)) {
        found.documents = [...found.documents, ...body.documents].slice(0, 20);
      }
    }
    if (action === 'approve' || action === 'reject') found.decidedAt = new Date().toISOString();
    if (typeof body.referenceNumber === 'string')
      found.referenceNumber = body.referenceNumber.trim();
    found.status = next;
    found.version += 1;
    found.events.push({
      at: new Date().toISOString(),
      action,
      toStatus: next,
      ...(amountMinor !== undefined ? { amountMinor } : {}),
      ...(note ? { note } : {}),
    });
    return HttpResponse.json(detail(found));
  }),
];

const ALL_ACTIONS: Record<Action, true> = {
  submit: true,
  raise_query: true,
  reply: true,
  approve: true,
  reject: true,
  settle: true,
  write_off: true,
  cancel: true,
};
