import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { currentSession, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockAdmissionOf } from './admissions-flow';
import { applyMockPayment, mockCharges, mockInvoices } from './billing';

type RunningBill = components['schemas']['RunningBill'];
type RunningBillLine = components['schemas']['RunningBillLine'];
type Deposit = components['schemas']['Deposit'];
type DepositList = components['schemas']['DepositList'];
type StaySettlement = components['schemas']['StaySettlement'];
type DischargePolicy = components['schemas']['DischargePolicy'];

// The running bill of an inpatient stay, its deposits and its estimate (DS-03, #166). Planned
// endpoints: the real API has none yet (#169), so this mock is the only implementation. It adds
// up the charge ledger of the stay's encounter (billing mock) and accrues the bed days itself.

const FEATURE_FLAG = 'billing';
const METHODS = ['cash', 'card', 'upi', 'bank', 'other'];
const SOURCES: RunningBillLine['source'][] = [
  'service',
  'order',
  'dispense',
  'bed',
  'procedure',
  'manual',
];

let deposits: (Deposit & { key: string })[] = [];
let estimates = new Map<string, { amountMinor: number; note?: string }>();
let answered = new Map<string, string>();
// Deposits set against an invoice and paid back, by admission (DS-04, #167).
let applied: { tenantId: string; admissionId: string; amountMinor: number }[] = [];
let refunded: { tenantId: string; admissionId: string; amountMinor: number }[] = [];
let policies = new Map<string, DischargePolicy['mode']>();

onMockReset(() => {
  applied = [];
  refunded = [];
  policies = new Map();
  deposits = [];
  estimates = new Map();
  answered = new Map();
});

const DAY = 86_400_000;
const utcDay = (iso: string | number) => Math.floor(new Date(iso).getTime() / DAY);

/** For tests: a deposit already taken against a stay. */
export function addMockDeposit(
  tenantId: string,
  admissionId: string,
  amountMinor: number,
  method: Deposit['method'] = 'cash',
): void {
  deposits.unshift({
    key: `seed:${deposits.length}`,
    id: `dep_mock_${deposits.length + 1}`,
    tenantId,
    admissionId,
    amountMinor,
    method,
    recordedByName: 'Seed',
    at: new Date().toISOString(),
  });
}

function billOf(tenantId: string, admissionId: string): RunningBill | undefined {
  const found = mockAdmissionOf(tenantId, admissionId);
  if (!found) return undefined;
  const { admission, stays } = found;
  const live = mockCharges().filter(
    (charge) =>
      charge.tenantId === tenantId &&
      charge.encounterId === admission.encounterId &&
      charge.status !== 'void',
  );
  const lines: RunningBillLine[] = [];
  for (const source of SOURCES) {
    const of = live.filter((charge) => charge.source === source);
    if (of.length > 0) {
      lines.push({
        source,
        count: of.length,
        totalMinor: of.reduce((sum, charge) => sum + charge.totalMinor, 0),
      });
    }
  }
  // Bed days to date from the stays, until the API posts them to the ledger as `bed` charges.
  if (!live.some((charge) => charge.source === 'bed')) {
    const end = admission.dischargedAt ?? new Date().toISOString();
    let count = 0;
    let totalMinor = 0;
    const parts = new Map<string, NonNullable<RunningBillLine['parts']>[number]>();
    for (const stay of stays) {
      const days = Math.max(1, utcDay(stay.releasedAt ?? end) - utcDay(stay.assignedAt) + 1);
      count += days;
      totalMinor += days * (stay.dayPriceMinor ?? 0);
      const unitPriceMinor = stay.dayPriceMinor ?? 0;
      const key = `${stay.bedCategoryId}:${unitPriceMinor}`;
      const part = parts.get(key) ?? {
        serviceId: stay.serviceId ?? stay.bedCategoryId,
        name: stay.bedCategoryId,
        days: 0,
        unitPriceMinor,
        totalMinor: 0,
      };
      part.days += days;
      part.totalMinor += days * unitPriceMinor;
      parts.set(key, part);
    }
    if (count > 0) {
      lines.unshift({
        source: 'bed',
        count,
        totalMinor,
        accruing: true,
        parts: [...parts.values()],
      });
    }
  }
  const chargesMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0);
  const invoicedMinor = live
    .filter((charge) => charge.status === 'invoiced')
    .reduce((sum, charge) => sum + charge.totalMinor, 0);
  const paidMinor =
    mockInvoices()
      .filter((invoice) => invoice.encounterId === admission.encounterId)
      .reduce((total, invoice) => total + invoice.paidMinor, 0) -
    applied
      .filter((each) => each.tenantId === tenantId && each.admissionId === admissionId)
      .reduce((total, each) => total + each.amountMinor, 0);
  // Deposits paid back no longer count; deposits set against an invoice are in its payments, so
  // they leave "paid" and stay in the deposits, and the balance counts them once.
  const sum = (list: { tenantId: string; admissionId: string; amountMinor: number }[]) =>
    list
      .filter((each) => each.tenantId === tenantId && each.admissionId === admissionId)
      .reduce((total, each) => total + each.amountMinor, 0);
  const depositsMinor = sum(deposits) - sum(refunded);
  const estimate = estimates.get(`${tenantId}:${admissionId}`);
  return {
    admissionId,
    encounterId: admission.encounterId,
    patientName: admission.patientName,
    patientMrn: admission.patientMrn,
    status: admission.status,
    asOf: new Date().toISOString(),
    lines,
    chargesMinor,
    invoicedMinor,
    paidMinor,
    depositsMinor,
    balanceMinor: chargesMinor - depositsMinor - paidMinor,
    ...(estimate ? { estimateMinor: estimate.amountMinor } : {}),
    ...(estimate?.note ? { estimateNote: estimate.note } : {}),
  };
}

type Movement = { tenantId: string; admissionId: string; amountMinor: number };

function settlementOf(tenantId: string, admissionId: string): StaySettlement | undefined {
  const found = mockAdmissionOf(tenantId, admissionId);
  if (!found) return undefined;
  const { admission } = found;
  const live = mockCharges().filter(
    (charge) =>
      charge.tenantId === tenantId &&
      charge.encounterId === admission.encounterId &&
      charge.status !== 'void',
  );
  const chargesMinor = live.reduce((sum, charge) => sum + charge.totalMinor, 0);
  const unbilledMinor = live
    .filter((charge) => charge.status !== 'invoiced')
    .reduce((sum, charge) => sum + charge.totalMinor, 0);
  const invoices = mockInvoices().filter(
    (invoice) => invoice.encounterId === admission.encounterId && invoice.status !== 'void',
  );
  const issued = invoices.filter((invoice) => invoice.status !== 'draft');
  const total = (pick: (invoice: (typeof issued)[number]) => number) =>
    issued.reduce((sum, invoice) => sum + pick(invoice), 0);
  const mine = (list: Movement[]) =>
    list
      .filter((each) => each.tenantId === tenantId && each.admissionId === admissionId)
      .reduce((sum, each) => sum + each.amountMinor, 0);
  const depositsMinor = mine(deposits);
  const depositsAppliedMinor = mine(applied);
  const depositsRefundedMinor = mine(refunded);
  const depositsHeldMinor = depositsMinor - depositsAppliedMinor - depositsRefundedMinor;
  const dueMinor = total(
    (invoice) => invoice.totalMinor - invoice.creditedMinor - invoice.paidMinor,
  );
  const draft = invoices.some((invoice) => invoice.status === 'draft');
  const excessDepositMinor =
    unbilledMinor === 0 && !draft ? Math.max(0, depositsHeldMinor - dueMinor) : 0;
  const reasons: StaySettlement['clearance']['reasons'] = [];
  if (unbilledMinor > 0) reasons.push('unbilled');
  if (draft) reasons.push('draft_invoice');
  if (dueMinor > 0) reasons.push('balance_due');
  if (excessDepositMinor > 0) reasons.push('excess_deposit');
  return {
    admissionId,
    patientName: admission.patientName,
    patientMrn: admission.patientMrn,
    status: admission.status,
    chargesMinor,
    unbilledMinor,
    invoicedMinor: total((invoice) => invoice.totalMinor),
    creditedMinor: total((invoice) => invoice.creditedMinor),
    paidMinor: total((invoice) => invoice.paidMinor),
    dueMinor,
    depositsMinor,
    depositsAppliedMinor,
    depositsRefundedMinor,
    depositsHeldMinor,
    excessDepositMinor,
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      ...(invoice.number ? { number: invoice.number } : {}),
      status: invoice.status,
      totalMinor: invoice.totalMinor,
      creditedMinor: invoice.creditedMinor,
      paidMinor: invoice.paidMinor,
    })),
    policy: policies.get(tenantId) ?? 'warn',
    clearance: { cleared: reasons.length === 0, reasons },
  };
}

const notFound = () => error(404, 'admission_not_found', 'No such admission');

async function keyed(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  if (!key) return { refused: error(400, 'validation_failed', 'Idempotency-Key is required') };
  const body: unknown = await request.json().catch(() => null);
  const keyOf = `${tenantId}:${new URL(request.url).pathname}:${key}`;
  const replay = answered.get(keyOf);
  if (replay !== undefined && replay !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    };
  }
  return { body, keyOf, replay: replay !== undefined };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const stayBillHandlers = [
  http.get('*/api/admissions/:admissionId/bill', ({ request, params }) => {
    const reading = authorize(request, { permission: 'admission:read', featureFlag: 'admissions' });
    if ('denied' in reading) return reading.denied;
    const access = authorize(request, { permission: 'charge:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const bill = billOf(access.tenantId, String(params.admissionId));
    return bill ? HttpResponse.json<RunningBill>(bill) : notFound();
  }),

  http.put('*/api/admissions/:admissionId/bill-estimate', async ({ request, params }) => {
    const access = authorize(request, { permission: 'invoice:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await keyed(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const admissionId = String(params.admissionId);
    if (!billOf(access.tenantId, admissionId)) return notFound();
    const body = sent.body;
    if (
      !isObject(body) ||
      !Number.isInteger(body.amountMinor) ||
      (body.amountMinor as number) < 0 ||
      (body.note !== undefined &&
        (typeof body.note !== 'string' || body.note.length > 300 || !PLAIN_TEXT.test(body.note)))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    estimates.set(`${access.tenantId}:${admissionId}`, {
      amountMinor: body.amountMinor as number,
      ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}),
    });
    answered.set(sent.keyOf, JSON.stringify(body));
    return HttpResponse.json<RunningBill>(billOf(access.tenantId, admissionId) as RunningBill);
  }),

  http.get('*/api/admissions/:admissionId/deposits', ({ request, params }) => {
    const access = authorize(request, { permission: 'payment:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const admissionId = String(params.admissionId);
    if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
    return HttpResponse.json<DepositList>({
      items: deposits
        .filter((each) => each.tenantId === access.tenantId && each.admissionId === admissionId)
        .map(({ key: _key, ...shown }) => shown),
    });
  }),

  http.post('*/api/admissions/:admissionId/deposits', async ({ request, params }) => {
    const access = authorize(request, { permission: 'payment:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await keyed(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const admissionId = String(params.admissionId);
    const found = mockAdmissionOf(access.tenantId, admissionId);
    if (!found) return notFound();
    const body = sent.body;
    if (
      !isObject(body) ||
      !Number.isInteger(body.amountMinor) ||
      (body.amountMinor as number) < 1 ||
      typeof body.method !== 'string' ||
      !METHODS.includes(body.method) ||
      (body.reference !== undefined &&
        (typeof body.reference !== 'string' ||
          body.reference.length < 1 ||
          body.reference.length > 100 ||
          !PLAIN_TEXT.test(body.reference)))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const repeated = deposits.find((each) => each.key === sent.keyOf);
    if (sent.replay && repeated) {
      const { key: _key, ...shown } = repeated;
      return HttpResponse.json<Deposit>(shown, { status: 201 });
    }
    if (found.admission.status !== 'admitted') {
      return error(409, 'stay_closed', 'The patient has been discharged');
    }
    const made = {
      key: sent.keyOf,
      id: `dep_mock_${deposits.length + 1}`,
      tenantId: access.tenantId,
      admissionId,
      amountMinor: body.amountMinor as number,
      method: body.method as Deposit['method'],
      ...(typeof body.reference === 'string' ? { reference: body.reference } : {}),
      recordedByName: currentSession()?.user.name ?? '',
      at: new Date().toISOString(),
    };
    deposits.unshift(made);
    answered.set(sent.keyOf, JSON.stringify(body));
    const { key: _key, ...shown } = made;
    return HttpResponse.json<Deposit>(shown, { status: 201 });
  }),

  http.get('*/api/admissions/:admissionId/settlement', ({ request, params }) => {
    const reading = authorize(request, { permission: 'admission:read', featureFlag: 'admissions' });
    if ('denied' in reading) return reading.denied;
    const access = authorize(request, { permission: 'charge:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const settlement = settlementOf(access.tenantId, String(params.admissionId));
    return settlement ? HttpResponse.json<StaySettlement>(settlement) : notFound();
  }),

  http.post('*/api/admissions/:admissionId/deposits/apply', async ({ request, params }) => {
    const access = authorize(request, { permission: 'payment:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await keyed(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const admissionId = String(params.admissionId);
    const before = settlementOf(access.tenantId, admissionId);
    if (!before) return notFound();
    const body = sent.body;
    if (!isObject(body) || typeof body.invoiceId !== 'string') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (!sent.replay) {
      if (before.depositsHeldMinor < 1) {
        return error(409, 'no_deposit_held', 'No deposit is held for this stay');
      }
      const invoice = before.invoices.find((each) => each.id === body.invoiceId);
      if (!invoice || invoice.status !== 'issued') {
        return error(409, 'invoice_not_payable', 'Only an issued invoice of the stay takes it');
      }
      const amountMinor = applyMockPayment(
        access.tenantId,
        invoice.id,
        before.depositsHeldMinor,
        'Deposit',
      );
      applied.push({ tenantId: access.tenantId, admissionId, amountMinor });
      answered.set(sent.keyOf, JSON.stringify(body));
    }
    const after = settlementOf(access.tenantId, admissionId);
    return after ? HttpResponse.json<StaySettlement>(after) : notFound();
  }),

  http.post('*/api/admissions/:admissionId/deposits/refund', async ({ request, params }) => {
    const access = authorize(request, { permission: 'payment:refund', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await keyed(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const admissionId = String(params.admissionId);
    const before = settlementOf(access.tenantId, admissionId);
    if (!before) return notFound();
    const body = sent.body;
    if (
      !isObject(body) ||
      !Number.isInteger(body.amountMinor) ||
      (body.amountMinor as number) < 1 ||
      typeof body.method !== 'string' ||
      !METHODS.includes(body.method) ||
      typeof body.reason !== 'string' ||
      body.reason.length < 1 ||
      body.reason.length > 200 ||
      !PLAIN_TEXT.test(body.reason)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (!sent.replay) {
      if ((body.amountMinor as number) > before.excessDepositMinor) {
        return error(409, 'refund_exceeds', 'More than the deposit held beyond what is due');
      }
      refunded.push({
        tenantId: access.tenantId,
        admissionId,
        amountMinor: body.amountMinor as number,
      });
      answered.set(sent.keyOf, JSON.stringify(body));
    }
    const after = settlementOf(access.tenantId, admissionId);
    return after ? HttpResponse.json<StaySettlement>(after) : notFound();
  }),

  http.get('*/api/billing/discharge-policy', ({ request }) => {
    const access = authorize(request, { permission: 'invoice:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    return HttpResponse.json<DischargePolicy>({ mode: policies.get(access.tenantId) ?? 'warn' });
  }),

  http.put('*/api/billing/discharge-policy', async ({ request }) => {
    const access = authorize(request, {
      permission: 'dischargePolicy:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const sent = await keyed(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const mode = isObject(sent.body) ? sent.body.mode : undefined;
    if (mode !== 'off' && mode !== 'warn' && mode !== 'block') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    policies.set(access.tenantId, mode);
    return HttpResponse.json<DischargePolicy>({ mode });
  }),
];
