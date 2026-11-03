import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { currentPolicy, currentSession, mockTenantCurrency, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockEncounter } from './clinical';
import { mockPatient } from './patients';
import { mockServicePrice } from './services';

type Charge = components['schemas']['Charge'];
type ChargePage = components['schemas']['ChargePage'];
type Invoice = components['schemas']['Invoice'];
type InvoiceLine = components['schemas']['InvoiceLine'];
type InvoicePage = components['schemas']['InvoicePage'];
type ManualLine = components['schemas']['ManualLine'];
type Payment = components['schemas']['Payment'];
type PaymentList = components['schemas']['PaymentList'];
type CreditNote = components['schemas']['CreditNote'];
type CreditNoteList = components['schemas']['CreditNoteList'];
type RegisterSession = components['schemas']['RegisterSession'];
type RegisterSessionPage = components['schemas']['RegisterSessionPage'];

/** A drawer as the mock keeps it: whose it is and the hospital it belongs to. */
interface StoredSession {
  id: string;
  tenantId: string;
  userId: string;
  openedByName: string;
  openedAt: string;
  openingMinor: number;
  closedAt?: string;
  countedMinor?: number;
  note?: string;
}

const METHODS = ['cash', 'card', 'upi', 'bank', 'other'];

// The billing API's charges and invoices (#109, planned as #114). Charges are posted by other
// modules' events in the real API; the mock seeds a few for the sample visits.

const FEATURE_FLAG = 'billing';
const CHARGES_MAX = 200;
const LINES_MAX = 50;

interface StoredInvoice {
  id: string;
  tenantId: string;
  encounterId: string;
  patientId: string;
  chargeIds: string[];
  manualLines: ManualLine[];
  status: Invoice['status'];
  number?: string;
  createdAt: string;
  issuedAt?: string;
  version: number;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function seed() {
  const charge = (
    id: string,
    tenantId: string,
    encounterId: string,
    source: Charge['source'],
    description: string,
    quantity: number,
    unitPriceMinor: number,
    ago: number,
  ): Charge => ({
    id,
    tenantId,
    encounterId,
    source,
    description,
    quantity,
    unitPriceMinor,
    totalMinor: quantity * unitPriceMinor,
    status: 'pending',
    postedAt: minutesAgo(ago),
  });
  const hospital = TENANT_IDS.hospital;
  const clinic = TENANT_IDS.clinic;
  return {
    // At the hospital, three charges on the open consultation: its fee, a blood count and a
    // dispensed medicine. At the clinic, the consultation's fee.
    charges: [
      charge('chg_h_1', hospital, 'enc_h_1', 'service', 'General consultation', 1, 50000, 60),
      charge('chg_h_2', hospital, 'enc_h_1', 'order', 'Complete blood count', 1, 35000, 40),
      charge(
        'chg_h_3',
        hospital,
        'enc_h_1',
        'dispense',
        'Paracetamol 500 mg, strip of 10',
        2,
        2550,
        10,
      ),
      charge('chg_c_1', clinic, 'enc_c_1', 'service', 'General consultation', 1, 15000, 30),
    ] as Charge[],
    invoices: [] as StoredInvoice[],
    printed: [] as { tenantId: string; invoiceId: string }[],
    payments: [] as (Payment & { tenantId: string })[],
    creditNotes: [] as (CreditNote & { tenantId: string })[],
    // Cash goes into the caller's open register session (#118).
    sessions: [] as StoredSession[],
    // Until a test says otherwise, a caller with no drawer open has one opened (with no cash in
    // it) by their first cash payment, as the mock's payments always took cash before the register.
    autoOpen: true,
  };
}

let state = seed();
let counter = 0;
let issuedCount = 0;
let answered = new Map<string, { body: string; id: string }>();

onMockReset(() => {
  state = seed();
  counter = 0;
  issuedCount = 0;
  answered = new Map();
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const caller = () => currentSession()?.user.id ?? '';

/** The visit, when it is one of this hospital's. */
function visitOf(tenantId: string, encounterId: string) {
  const found = mockEncounter(encounterId);
  return found && found.tenantId === tenantId ? found : undefined;
}

const notFound = () => error(404, 'not_found', 'Not found');

function invoiceView(stored: StoredInvoice): Invoice {
  const patient = mockPatient(stored.tenantId, stored.patientId);
  const lines: InvoiceLine[] = [
    ...stored.chargeIds.flatMap((id): InvoiceLine[] => {
      const found = state.charges.find((each) => each.id === id);
      return found
        ? [
            {
              id: `ln_${found.id}`,
              chargeId: found.id,
              source: found.source,
              description: found.description,
              quantity: found.quantity,
              unitPriceMinor: found.unitPriceMinor,
              totalMinor: found.totalMinor,
            },
          ]
        : [];
    }),
    ...stored.manualLines.map((line, index): InvoiceLine => ({
      id: `ln_${stored.id}_m${index}`,
      source: 'manual',
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      totalMinor: line.quantity * line.unitPriceMinor,
    })),
  ];
  return {
    id: stored.id,
    tenantId: stored.tenantId,
    encounterId: stored.encounterId,
    patientId: stored.patientId,
    patientName: patient?.name ?? '',
    patientMrn: patient?.mrn ?? '',
    ...(stored.number ? { number: stored.number } : {}),
    status: stored.status,
    lines,
    totalMinor: lines.reduce((sum, line) => sum + line.totalMinor, 0),
    paidMinor: state.payments
      .filter((each) => each.invoiceId === stored.id)
      .reduce(
        (sum, each) => sum + (each.kind === 'refund' ? -each.amountMinor : each.amountMinor),
        0,
      ),
    creditedMinor: state.creditNotes
      .filter((each) => each.invoiceId === stored.id)
      .reduce((sum, each) => sum + each.amountMinor, 0),
    currency: mockTenantCurrency(stored.tenantId),
    createdAt: stored.createdAt,
    ...(stored.issuedAt ? { issuedAt: stored.issuedAt } : {}),
    version: stored.version,
  };
}

/** A page of ids in order, by cursor (the id of the first item of the next page). */
function paged<T extends { id: string }>(items: T[], request: Request) {
  const query = new URL(request.url).searchParams;
  const limit = Number(query.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { refused: error(400, 'validation_failed', 'Bad limit') };
  }
  const cursor = query.get('cursor');
  const first = cursor ? items.findIndex((each) => each.id === cursor) : 0;
  if (first < 0) return { refused: error(400, 'invalid_cursor', 'Unknown cursor') };
  const next = items[first + limit];
  return {
    page: {
      items: items.slice(first, first + limit),
      nextCursor: next?.id ?? null,
      total: items.length,
    },
  };
}

/** What a draft is made of, checked as the API checks it, or the response to refuse it with. */
function contentOf(
  body: unknown,
): { chargeIds: string[]; manualLines: ManualLine[] } | { refused: Response } {
  const invalid = { refused: error(400, 'validation_failed', 'The request is not valid') };
  if (!isObject(body) || !Array.isArray(body.chargeIds) || !Array.isArray(body.manualLines)) {
    return invalid;
  }
  if (body.chargeIds.length > CHARGES_MAX || body.manualLines.length > LINES_MAX) return invalid;
  if (!body.chargeIds.every((id): id is string => typeof id === 'string' && id.length <= 64)) {
    return invalid;
  }
  const manualLines: ManualLine[] = [];
  for (const line of body.manualLines as unknown[]) {
    if (
      !isObject(line) ||
      typeof line.description !== 'string' ||
      line.description.trim() === '' ||
      line.description.length > 200 ||
      !PLAIN_TEXT.test(line.description) ||
      !Number.isInteger(line.quantity) ||
      (line.quantity as number) < 1 ||
      (line.quantity as number) > 9999 ||
      !Number.isInteger(line.unitPriceMinor) ||
      (line.unitPriceMinor as number) < 0
    ) {
      return invalid;
    }
    manualLines.push({
      description: line.description.trim(),
      quantity: line.quantity as number,
      unitPriceMinor: line.unitPriceMinor as number,
    });
  }
  return { chargeIds: [...new Set(body.chargeIds)], manualLines };
}

/**
 * Whether these charges may go on the invoice: of this visit and hospital, still pending, and
 * held by no other draft. The refusal is 409 `charge_unavailable`, as the API's.
 */
function chargesAvailable(
  tenantId: string,
  encounterId: string,
  chargeIds: string[],
  invoiceId: string | undefined,
) {
  return chargeIds.every((id) => {
    const found = state.charges.find((each) => each.id === id);
    return (
      found !== undefined &&
      found.tenantId === tenantId &&
      found.encounterId === encounterId &&
      found.status === 'pending' &&
      (found.invoiceId === undefined || found.invoiceId === invoiceId)
    );
  });
}

function holdCharges(invoice: StoredInvoice, chargeIds: string[]) {
  for (const each of state.charges) {
    if (each.invoiceId === invoice.id && !chargeIds.includes(each.id)) delete each.invoiceId;
    if (chargeIds.includes(each.id)) each.invoiceId = invoice.id;
  }
  invoice.chargeIds = chargeIds;
}

/** The idempotency key of a POST: required, kept per hospital and user, as the API's. */
async function idempotent(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  if (!key) {
    return { refused: error(400, 'validation_failed', 'Idempotency-Key is required') };
  }
  const body: unknown = await request.json().catch(() => null);
  const keyOf = `${tenantId}:${caller()}:${new URL(request.url).pathname}:${key}`;
  const replay = answered.get(keyOf);
  if (replay && replay.body !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    };
  }
  return { body, keyOf, replay };
}

const mayAdjust = () =>
  currentPolicy()?.permissions.some((grant) => grant.permission === 'invoice:adjust') ?? false;

const invoiceFor = (tenantId: string, id: string) =>
  state.invoices.find((each) => each.id === id && each.tenantId === tenantId);

/** The caller's open drawer; with `autoOpen`, one is opened for them when they have none. */
function drawerFor(tenantId: string, userId: string): StoredSession | undefined {
  const open = state.sessions.find(
    (each) => each.tenantId === tenantId && each.userId === userId && !each.closedAt,
  );
  if (open || !state.autoOpen) return open;
  const made: StoredSession = {
    id: `reg_mock_${state.sessions.length + 1}`,
    tenantId,
    userId,
    openedByName: currentSession()?.user.name ?? '',
    openedAt: new Date().toISOString(),
    openingMinor: 0,
  };
  state.sessions.push(made);
  return made;
}

/** A drawer as the API shows it: what it took by payment mode and the cash it should hold. */
function sessionView(stored: StoredSession): RegisterSession {
  const mine = state.payments.filter((each) => each.sessionId === stored.id);
  const totals = METHODS.flatMap((method): RegisterSession['totals'] => {
    const rows = mine.filter((each) => each.method === method);
    if (rows.length === 0) return [];
    const sum = (kind: 'payment' | 'refund') =>
      rows
        .filter((each) => each.kind === kind)
        .reduce((total, each) => total + each.amountMinor, 0);
    return [
      {
        method: method as RegisterSession['totals'][number]['method'],
        paidMinor: sum('payment'),
        refundedMinor: sum('refund'),
      },
    ];
  });
  const cash = totals.find((each) => each.method === 'cash');
  const expectedMinor = stored.openingMinor + (cash?.paidMinor ?? 0) - (cash?.refundedMinor ?? 0);
  return {
    id: stored.id,
    openedByName: stored.openedByName,
    openedAt: stored.openedAt,
    openingMinor: stored.openingMinor,
    ...(stored.closedAt ? { closedAt: stored.closedAt } : {}),
    expectedMinor,
    ...(stored.countedMinor !== undefined
      ? { countedMinor: stored.countedMinor, differenceMinor: stored.countedMinor - expectedMinor }
      : {}),
    ...(stored.note ? { note: stored.note } : {}),
    totals,
  };
}

export const billingHandlers = [
  http.get('*/api/encounters/:encounterId/charges', ({ request, params }) => {
    const access = authorize(request, { permission: 'charge:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const encounterId = String(params.encounterId);
    if (!visitOf(tenantId, encounterId)) return notFound();
    const status = new URL(request.url).searchParams.get('status');
    const charges = state.charges.filter(
      (each) =>
        each.tenantId === tenantId &&
        each.encounterId === encounterId &&
        (status === null || each.status === status),
    );
    const result = paged(charges, request);
    return 'refused' in result ? result.refused : HttpResponse.json<ChargePage>(result.page);
  }),

  // Charges a service of the price catalog to a visit by hand (#115): priced by the server from
  // the price list in effect, never by the client.
  http.post('*/api/encounters/:encounterId/charges', async ({ request, params }) => {
    const access = authorize(request, { permission: 'charge:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const visit = visitOf(tenantId, String(params.encounterId));
    if (!visit) return notFound();
    if (sent.replay) {
      const again = state.charges.find((each) => each.id === sent.replay?.id);
      return again ? HttpResponse.json<Charge>(again, { status: 201 }) : notFound();
    }
    const body = sent.body;
    const serviceId = isObject(body) ? body.serviceId : undefined;
    const quantity = isObject(body) ? body.quantity : undefined;
    if (
      typeof serviceId !== 'string' ||
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 9999
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (visit.status === 'cancelled') {
      return error(409, 'encounter_cancelled', 'The visit was cancelled');
    }
    const service = mockServicePrice(tenantId, serviceId);
    if (!service) return error(404, 'service_not_found', 'No such service');
    if (service.archived) return error(409, 'service_archived', 'The service is archived');
    if (service.amountMinor === null) return error(409, 'no_price', 'The service has no price');
    counter += 1;
    const made: Charge = {
      id: `chg_new_${counter}`,
      tenantId,
      encounterId: visit.id,
      source: 'service',
      description: service.name,
      quantity,
      unitPriceMinor: service.amountMinor,
      totalMinor: quantity * service.amountMinor,
      status: 'pending',
      postedAt: new Date().toISOString(),
    };
    state.charges.push(made);
    answered.set(sent.keyOf, { body: JSON.stringify(sent.body), id: made.id });
    return HttpResponse.json<Charge>(made, { status: 201 });
  }),

  http.get('*/api/encounters/:encounterId/invoices', ({ request, params }) => {
    const access = authorize(request, { permission: 'invoice:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const encounterId = String(params.encounterId);
    if (!visitOf(tenantId, encounterId)) return notFound();
    const newestFirst = state.invoices
      .filter((each) => each.tenantId === tenantId && each.encounterId === encounterId)
      .reverse();
    const result = paged(newestFirst, request);
    return 'refused' in result
      ? result.refused
      : HttpResponse.json<InvoicePage>({
          ...result.page,
          items: result.page.items.map(invoiceView),
        });
  }),

  http.post('*/api/encounters/:encounterId/invoices', async ({ request, params }) => {
    const access = authorize(request, { permission: 'invoice:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const visit = visitOf(tenantId, String(params.encounterId));
    if (!visit) return notFound();
    if (sent.replay) {
      const again = invoiceFor(tenantId, sent.replay.id);
      return again ? HttpResponse.json<Invoice>(invoiceView(again), { status: 201 }) : notFound();
    }
    const content = contentOf(sent.body);
    if ('refused' in content) return content.refused;
    if (content.manualLines.length > 0 && !mayAdjust()) {
      return error(403, 'permission_denied', 'invoice:adjust is needed for typed lines');
    }
    if (visit.status === 'cancelled') {
      return error(409, 'encounter_cancelled', 'The visit was cancelled');
    }
    if (content.chargeIds.length + content.manualLines.length === 0) {
      return error(422, 'empty_invoice', 'An invoice needs at least one line');
    }
    if (!chargesAvailable(tenantId, visit.id, content.chargeIds, undefined)) {
      return error(409, 'charge_unavailable', 'A charge is billed or in another draft');
    }
    const stored: StoredInvoice = {
      id: `inv_mock_${++counter}`,
      tenantId,
      encounterId: visit.id,
      patientId: visit.patientId,
      chargeIds: [],
      manualLines: content.manualLines,
      status: 'draft',
      createdAt: new Date().toISOString(),
      version: 1,
    };
    holdCharges(stored, content.chargeIds);
    state.invoices.push(stored);
    answered.set(sent.keyOf, { body: JSON.stringify(sent.body), id: stored.id });
    return HttpResponse.json<Invoice>(invoiceView(stored), { status: 201 });
  }),

  http.post('*/api/invoices/search', async ({ request }) => {
    const access = authorize(request, { permission: 'invoice:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body: unknown = await request.json().catch(() => null);
    const q =
      isObject(body) && typeof body.q === 'string'
        ? body.q.toLowerCase().split(/\s+/).filter(Boolean)
        : [];
    const status = isObject(body) && typeof body.status === 'string' ? body.status : null;
    const found = state.invoices
      .filter((each) => each.tenantId === access.tenantId)
      .map(invoiceView)
      .filter((each) => status === null || each.status === status)
      .filter((each) => {
        const hay = `${each.number ?? ''} ${each.patientName} ${each.patientMrn}`.toLowerCase();
        return q.every((word) => hay.includes(word));
      })
      .reverse();
    const url = new URL(request.url);
    if (isObject(body)) {
      if (typeof body.cursor === 'string') url.searchParams.set('cursor', body.cursor);
      if (typeof body.limit === 'number') url.searchParams.set('limit', String(body.limit));
    }
    const result = paged(found, new Request(url));
    return 'refused' in result ? result.refused : HttpResponse.json<InvoicePage>(result.page);
  }),

  http.post('*/api/invoices/:invoiceId/print', async ({ request, params }) => {
    for (const permission of ['invoice:read', 'invoice:print']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const found = invoiceFor(tenantId, String(params.invoiceId));
    if (!found) return notFound();
    if (found.status === 'draft' || found.status === 'void') {
      return error(409, 'not_printable', 'Only an issued invoice is printed');
    }
    const keyOf = `${tenantId}:${caller()}:print:${key}`;
    if (!answered.has(keyOf)) {
      answered.set(keyOf, { body: '', id: found.id });
      state.printed.push({ tenantId, invoiceId: found.id });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/invoices/:invoiceId/payments', ({ request, params }) => {
    const access = authorize(request, { permission: 'payment:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const tenantId = currentPolicy()?.tenantId ?? '';
    const found = invoiceFor(tenantId, String(params.invoiceId));
    if (!found) return notFound();
    return HttpResponse.json<PaymentList>({
      items: state.payments
        .filter((each) => each.invoiceId === found.id)
        .map(({ tenantId: _tenant, ...payment }) => payment),
    });
  }),

  http.post('*/api/invoices/:invoiceId/payments', async ({ request, params }) => {
    for (const permission of ['payment:create', 'payment:read']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const found = invoiceFor(tenantId, String(params.invoiceId));
    if (!found) return notFound();
    // A repeat records nothing more and answers with the payment.
    if (sent.replay) {
      const again = state.payments.find((each) => each.id === sent.replay?.id);
      if (again) {
        const { tenantId: _tenant, ...payment } = again;
        return HttpResponse.json<Payment>(payment, { status: 201 });
      }
    }
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
    if (found.status !== 'issued') {
      return error(409, 'invoice_not_payable', 'Only an issued invoice takes a payment');
    }
    const view = invoiceView(found);
    if ((body.amountMinor as number) > view.totalMinor - view.paidMinor - view.creditedMinor) {
      return error(409, 'overpayment', 'More than is still due');
    }
    const drawer = body.method === 'cash' ? drawerFor(tenantId, caller()) : undefined;
    if (body.method === 'cash' && !drawer) {
      return error(409, 'no_open_register', 'Open a cash register session first');
    }
    const payment: Payment & { tenantId: string } = {
      id: `pay_mock_${state.payments.length + 1}`,
      tenantId,
      invoiceId: found.id,
      kind: 'payment',
      amountMinor: body.amountMinor as number,
      method: body.method as Payment['method'],
      ...(typeof body.reference === 'string' ? { reference: body.reference } : {}),
      ...(drawer ? { sessionId: drawer.id } : {}),
      recordedByName: currentSession()?.user.name ?? '',
      at: new Date().toISOString(),
    };
    state.payments.push(payment);
    if (view.totalMinor - view.paidMinor - view.creditedMinor === payment.amountMinor) {
      found.status = 'paid';
      found.version += 1;
    }
    answered.set(sent.keyOf, { body: JSON.stringify(body), id: payment.id });
    const { tenantId: _tenant, ...shown } = payment;
    return HttpResponse.json<Payment>(shown, { status: 201 });
  }),

  http.post('*/api/payments/:paymentId/refunds', async ({ request, params }) => {
    for (const permission of ['payment:refund', 'payment:read']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    // A repeat refunds nothing more and answers with the refund.
    if (sent.replay) {
      const again = state.payments.find((each) => each.id === sent.replay?.id);
      if (again) {
        const { tenantId: _tenant, ...refund } = again;
        return HttpResponse.json<Payment>(refund, { status: 201 });
      }
    }
    const original = state.payments.find(
      (each) =>
        each.tenantId === tenantId &&
        each.id === String(params.paymentId) &&
        each.kind === 'payment',
    );
    const found = original ? invoiceFor(tenantId, original.invoiceId) : undefined;
    if (!original || !found) return notFound();
    const body = sent.body;
    if (
      !isObject(body) ||
      !Number.isInteger(body.amountMinor) ||
      (body.amountMinor as number) < 1 ||
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 1 ||
      body.reason.length > 200 ||
      !PLAIN_TEXT.test(body.reason)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (found.status !== 'issued' && found.status !== 'paid') {
      return error(409, 'invoice_not_payable', 'Only an issued or paid invoice takes a refund');
    }
    const held =
      original.amountMinor -
      state.payments
        .filter((each) => each.kind === 'refund' && each.refundOf === original.id)
        .reduce((sum, each) => sum + each.amountMinor, 0);
    if ((body.amountMinor as number) > held) {
      return error(409, 'refund_exceeds', 'More than the payment still holds');
    }
    const drawer = original.method === 'cash' ? drawerFor(tenantId, caller()) : undefined;
    if (original.method === 'cash' && !drawer) {
      return error(409, 'no_open_register', 'Open a cash register session first');
    }
    const refund: Payment & { tenantId: string } = {
      id: `pay_mock_${state.payments.length + 1}`,
      tenantId,
      invoiceId: found.id,
      kind: 'refund',
      amountMinor: body.amountMinor as number,
      method: original.method,
      refundOf: original.id,
      reason: body.reason,
      ...(drawer ? { sessionId: drawer.id } : {}),
      recordedByName: currentSession()?.user.name ?? '',
      at: new Date().toISOString(),
    };
    state.payments.push(refund);
    // A paid invoice that gives money back is issued again, with something due.
    if (found.status === 'paid') {
      found.status = 'issued';
      found.version += 1;
    }
    answered.set(sent.keyOf, { body: JSON.stringify(body), id: refund.id });
    const { tenantId: _tenant, ...shown } = refund;
    return HttpResponse.json<Payment>(shown, { status: 201 });
  }),

  http.get('*/api/invoices/:invoiceId/credit-notes', ({ request, params }) => {
    const access = authorize(request, { permission: 'invoice:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = invoiceFor(access.tenantId, String(params.invoiceId));
    if (!found) return notFound();
    return HttpResponse.json<CreditNoteList>({
      items: state.creditNotes
        .filter((each) => each.invoiceId === found.id)
        .map(({ tenantId: _tenant, ...note }) => note),
    });
  }),

  http.post('*/api/invoices/:invoiceId/credit-notes', async ({ request, params }) => {
    for (const permission of ['creditNote:create', 'invoice:read']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const found = invoiceFor(tenantId, String(params.invoiceId));
    if (!found) return notFound();
    // A repeat issues nothing more and answers with the credit note.
    if (sent.replay) {
      const again = state.creditNotes.find((each) => each.id === sent.replay?.id);
      if (again) {
        const { tenantId: _tenant, ...note } = again;
        return HttpResponse.json<CreditNote>(note, { status: 201 });
      }
    }
    const body = sent.body;
    if (
      !isObject(body) ||
      !Number.isInteger(body.amountMinor) ||
      (body.amountMinor as number) < 1 ||
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 1 ||
      body.reason.length > 200 ||
      !PLAIN_TEXT.test(body.reason)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (found.status !== 'issued' && found.status !== 'paid') {
      return error(409, 'invoice_not_creditable', 'Only an issued invoice takes a credit note');
    }
    const view = invoiceView(found);
    const amount = body.amountMinor as number;
    if (amount > view.totalMinor - view.creditedMinor) {
      return error(409, 'credit_exceeds', 'More than is left of the invoice');
    }
    if (view.paidMinor > view.totalMinor - view.creditedMinor - amount) {
      return error(409, 'refund_first', 'Refund the money paid first');
    }
    const note: CreditNote & { tenantId: string } = {
      id: `cn_mock_${state.creditNotes.length + 1}`,
      tenantId,
      invoiceId: found.id,
      number: `CN-${String(state.creditNotes.length + 1).padStart(4, '0')}`,
      amountMinor: amount,
      reason: body.reason.trim(),
      createdByName: currentSession()?.user.name ?? '',
      createdAt: new Date().toISOString(),
    };
    state.creditNotes.push(note);
    // Credited in full: the invoice is void and its charges are to be billed again.
    if (amount === view.totalMinor - view.creditedMinor) {
      found.status = 'void';
      found.version += 1;
      for (const each of state.charges) {
        if (each.invoiceId === found.id) {
          each.status = 'pending';
          delete each.invoiceId;
        }
      }
    }
    answered.set(sent.keyOf, { body: JSON.stringify(body), id: note.id });
    const { tenantId: _tenant, ...shown } = note;
    return HttpResponse.json<CreditNote>(shown, { status: 201 });
  }),

  http.get('*/api/invoices/:invoiceId', ({ request, params }) => {
    const access = authorize(request, { permission: 'invoice:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = invoiceFor(access.tenantId, String(params.invoiceId));
    return found ? HttpResponse.json<Invoice>(invoiceView(found)) : notFound();
  }),

  http.patch('*/api/invoices/:invoiceId', async ({ request, params }) => {
    const access = authorize(request, { permission: 'invoice:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const found = invoiceFor(tenantId, String(params.invoiceId));
    if (!found) return notFound();
    const body: unknown = await request.json().catch(() => null);
    const content = contentOf(body);
    if ('refused' in content) return content.refused;
    if (!isObject(body) || !Number.isInteger(body.version)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (found.status !== 'draft') {
      return error(409, 'invoice_not_draft', 'The invoice was issued');
    }
    if (body.version !== found.version) {
      return error(409, 'version_conflict', 'The draft changed since it was read');
    }
    if (content.manualLines.length > 0 && !mayAdjust()) {
      return error(403, 'permission_denied', 'invoice:adjust is needed for typed lines');
    }
    if (content.chargeIds.length + content.manualLines.length === 0) {
      return error(422, 'empty_invoice', 'An invoice needs at least one line');
    }
    if (!chargesAvailable(tenantId, found.encounterId, content.chargeIds, found.id)) {
      return error(409, 'charge_unavailable', 'A charge is billed or in another draft');
    }
    holdCharges(found, content.chargeIds);
    found.manualLines = content.manualLines;
    found.version += 1;
    return HttpResponse.json<Invoice>(invoiceView(found));
  }),

  http.post('*/api/invoices/:invoiceId/issue', async ({ request, params }) => {
    const access = authorize(request, { permission: 'invoice:issue', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const found = invoiceFor(tenantId, String(params.invoiceId));
    if (!found) return notFound();
    // A repeat of the same request answers with the invoice as it is now.
    if (sent.replay) return HttpResponse.json<Invoice>(invoiceView(found));
    const body = sent.body;
    if (!isObject(body) || !Number.isInteger(body.version)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (found.status !== 'draft') return error(409, 'invoice_not_draft', 'The invoice was issued');
    if (body.version !== found.version) {
      return error(409, 'version_conflict', 'The draft changed since it was read');
    }
    if (mockEncounter(found.encounterId)?.status === 'cancelled') {
      return error(409, 'encounter_cancelled', 'The visit was cancelled');
    }
    found.status = 'issued';
    found.number = `INV-${String(++issuedCount).padStart(4, '0')}`;
    found.issuedAt = new Date().toISOString();
    found.version += 1;
    for (const each of state.charges) {
      if (each.invoiceId === found.id) each.status = 'invoiced';
    }
    answered.set(sent.keyOf, { body: JSON.stringify(body), id: found.id });
    return HttpResponse.json<Invoice>(invoiceView(found));
  }),

  // The cash register (#118): one drawer open a person; cash payments go into it.
  http.get('*/api/cash-registers/sessions/current', ({ request }) => {
    const access = authorize(request, {
      permission: 'cashRegister:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const open = state.sessions.find(
      (each) => each.tenantId === access.tenantId && each.userId === caller() && !each.closedAt,
    );
    return open
      ? HttpResponse.json<RegisterSession>(sessionView(open))
      : error(404, 'session_not_found', 'No register session is open');
  }),

  http.get('*/api/cash-registers/sessions', ({ request }) => {
    const access = authorize(request, {
      permission: 'cashRegister:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const mine = state.sessions
      .filter((each) => each.tenantId === access.tenantId)
      .map(sessionView)
      .reverse();
    const result = paged(mine, request);
    return 'refused' in result
      ? result.refused
      : HttpResponse.json<RegisterSessionPage>(result.page);
  }),

  http.get('*/api/cash-registers/sessions/:sessionId', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'cashRegister:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const found = state.sessions.find(
      (each) => each.tenantId === access.tenantId && each.id === String(params.sessionId),
    );
    return found ? HttpResponse.json<RegisterSession>(sessionView(found)) : notFound();
  }),

  http.post('*/api/cash-registers/sessions', async ({ request }) => {
    const access = authorize(request, {
      permission: 'cashRegister:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) {
      const again = state.sessions.find((each) => each.id === sent.replay?.id);
      if (again) return HttpResponse.json<RegisterSession>(sessionView(again), { status: 201 });
    }
    const body = sent.body;
    if (
      !isObject(body) ||
      !Number.isInteger(body.openingMinor) ||
      (body.openingMinor as number) < 0 ||
      (body.openingMinor as number) > 1_000_000_000_000
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (
      state.sessions.some(
        (each) => each.tenantId === tenantId && each.userId === caller() && !each.closedAt,
      )
    ) {
      return error(409, 'register_open', 'You already have a register open');
    }
    const made: StoredSession = {
      id: `reg_mock_${state.sessions.length + 1}`,
      tenantId,
      userId: caller(),
      openedByName: currentSession()?.user.name ?? '',
      openedAt: new Date().toISOString(),
      openingMinor: body.openingMinor as number,
    };
    state.sessions.push(made);
    answered.set(sent.keyOf, { body: JSON.stringify(body), id: made.id });
    return HttpResponse.json<RegisterSession>(sessionView(made), { status: 201 });
  }),

  http.post('*/api/cash-registers/sessions/:sessionId/close', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'cashRegister:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    // Only the opener closes it; another person's drawer is not found.
    const found = state.sessions.find(
      (each) =>
        each.tenantId === tenantId &&
        each.id === String(params.sessionId) &&
        each.userId === caller(),
    );
    if (!found) return notFound();
    if (sent.replay) return HttpResponse.json<RegisterSession>(sessionView(found));
    const body = sent.body;
    if (
      !isObject(body) ||
      !Number.isInteger(body.countedMinor) ||
      (body.countedMinor as number) < 0 ||
      (body.countedMinor as number) > 1_000_000_000_000 ||
      (body.note !== undefined &&
        (typeof body.note !== 'string' ||
          body.note.length < 1 ||
          body.note.length > 300 ||
          !PLAIN_TEXT.test(body.note)))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (found.closedAt) return error(409, 'register_closed', 'This register was already settled');
    found.closedAt = new Date().toISOString();
    found.countedMinor = body.countedMinor as number;
    if (typeof body.note === 'string') found.note = body.note;
    answered.set(sent.keyOf, { body: JSON.stringify(body), id: found.id });
    return HttpResponse.json<RegisterSession>(sessionView(found));
  }),
];

/** The charges as the mock holds them now, for tests. */
export const mockCharges = (): readonly Charge[] => state.charges;

/** The prints recorded so far (the audit log's), for tests. */
export const mockPrints = (): readonly { tenantId: string; invoiceId: string }[] => state.printed;

/** The invoices as the mock holds them now, for tests. */
export const mockInvoices = (): Invoice[] => state.invoices.map(invoiceView);

/** The payments recorded so far, for tests. */
export const mockPayments = (): readonly Payment[] => state.payments;

/** The credit notes issued so far, for tests. */
export const mockCreditNotes = (): readonly CreditNote[] => state.creditNotes;

/**
 * Whether a caller with no drawer gets one opened by their first cash payment (the default, as
 * before the register had screens), or is refused with `no_open_register` until they open one.
 * Turning it off also settles every drawer that is open now, so nobody has one: for tests of cash
 * payments and refunds without a register, and of the register itself.
 */
export function setMockRegisterOpen(autoOpen: boolean): void {
  state.autoOpen = autoOpen;
  if (!autoOpen) {
    for (const each of state.sessions) {
      if (!each.closedAt) {
        each.closedAt = new Date().toISOString();
        each.countedMinor = sessionView(each).expectedMinor;
      }
    }
  }
}

/** The register sessions as the mock holds them, oldest first, for tests. */
export const mockRegisterSessions = (): RegisterSession[] => state.sessions.map(sessionView);
