import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Permission } from '../../core/access/registry.js';
import type { DischargeGate } from '../../core/discharge-gate/registry.js';
import type { Database } from '../../core/db/client.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { dueBedDays } from './bed-days.js';
import { priceOf } from './posting.js';
import {
  insertPayment,
  isUuid,
  lockInvoice,
  lockSession,
  num,
  openSessionOf,
  updateSettlement,
} from './repository.js';
import { REASON_MAX } from './schemas.js';
import {
  DEPOSIT_REFERENCE_MAX,
  ESTIMATE_NOTE_MAX,
  STAY_SCHEMAS,
  BillEstimateSet,
  Deposit,
  DepositApply,
  DepositCreate,
  DepositList,
  DepositRefund,
  DischargePolicy,
  RunningBill,
  StayParams,
  StaySettlement,
} from './stay-schemas.js';
import { FEATURE, requireAll, userIdOf } from './views.js';

/**
 * The running bill, deposits, final settlement and the discharge policy of an inpatient stay
 * (DS-03 #166, DS-04 #167; API in BE-25 #169). Billing reads the stay's admission and bed rows
 * but never writes them; a stay's charges are the ledger of its encounter. Deposits are an
 * append-only ledger of their own (taken, set against an invoice, paid back) beside the
 * payments of invoices, and a deposit set against an invoice is also a payment of method
 * `other` with the reference "Deposit", touching no register.
 */
const notFound = () => new HttpError(404, 'admission_not_found', 'No such admission');
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const SOURCE_ORDER = ['service', 'package', 'order', 'dispense', 'bed', 'procedure', 'manual'];

interface StayRow {
  id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  status: 'admitted' | 'discharged' | 'cancelled';
}

/** The admission, locked against other changes of its money when `lock` is set. */
async function findStay(client: pg.ClientBase, id: string, lock = false): Promise<StayRow> {
  const { rows } = await client.query<StayRow>(
    `select a.id, a.encounter_id, a.patient_id, p.first_name || ' ' || p.last_name as patient_name,
       p.mrn as patient_mrn, a.status
     from admissions a join patients p on p.tenant_id = a.tenant_id and p.id = a.patient_id
     where a.id = $1${lock ? ' for update of a' : ''}`,
    [isUuid(id) ? id : ZERO_ID],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function policyOf(client: pg.ClientBase): Promise<'off' | 'warn' | 'block'> {
  const { rows } = await client.query<{ discharge_policy: 'off' | 'warn' | 'block' }>(
    'select discharge_policy from billing_settings',
  );
  return rows[0]?.discharge_policy ?? 'warn';
}

async function sumOf(client: pg.ClientBase, table: string, admissionId: string): Promise<number> {
  const { rows } = await client.query<{ sum: string }>(
    `select coalesce(sum(amount_minor), 0)::text as sum from ${table} where admission_id = $1`,
    [admissionId],
  );
  return num(rows[0]?.sum);
}

async function runningBill(client: pg.ClientBase, db: Database, stay: StayRow) {
  const { rows: grouped } = await client.query<{ source: string; count: number; total: string }>(
    `select source, count(*)::int as count, sum(total_minor)::text as total from charges
     where encounter_id = $1 and status <> 'void' group by source`,
    [stay.encounter_id],
  );
  interface Part {
    serviceId: string;
    name: string;
    days: number;
    unitPriceMinor: number;
    totalMinor: number;
  }
  const lines: {
    source: string;
    count: number;
    totalMinor: number;
    accruing?: boolean;
    parts?: Part[];
  }[] = grouped
    .map((row) => ({ source: row.source, count: row.count, totalMinor: num(row.total) }))
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  // The bed days already posted, split by service and day price.
  const { rows: posted } = await client.query<{
    service_id: string;
    name: string;
    unit: string;
    days: number;
  }>(
    `select c.service_id, c.description as name, c.unit_price_minor::text as unit,
            sum(c.quantity)::int as days
     from charges c
     where c.encounter_id = $1 and c.source = 'bed' and c.status <> 'void' and c.service_id is not null
     group by c.service_id, c.description, c.unit_price_minor`,
    [stay.encounter_id],
  );
  const split = (entries: { serviceId: string; name: string; unit: number; days: number }[]) => {
    const parts = new Map<string, Part>();
    for (const entry of entries) {
      const key = `${entry.serviceId}:${entry.unit}`;
      const part = parts.get(key) ?? {
        serviceId: entry.serviceId,
        name: entry.name,
        days: 0,
        unitPriceMinor: entry.unit,
        totalMinor: 0,
      };
      part.days += entry.days;
      part.totalMinor += entry.unit * entry.days;
      parts.set(key, part);
    }
    return [...parts.values()].sort(
      (x, y) => x.name.localeCompare(y.name) || x.unitPriceMinor - y.unitPriceMinor,
    );
  };
  const bed = lines.find((line) => line.source === 'bed');
  if (bed) {
    bed.parts = split(
      posted.map((row) => ({
        serviceId: row.service_id,
        name: row.name,
        unit: num(row.unit),
        days: row.days,
      })),
    );
  }
  // Bed days the job has not posted yet, each at the price in effect on its own date.
  const due = await dueBedDays(client, stay.id, 10_000);
  if (due.length > 0) {
    let totalMinor = 0;
    const entries: { serviceId: string; name: string; unit: number; days: number }[] = [];
    for (const day of due) {
      const price = await priceOf(db, day.service_id, day.day);
      const unit = price?.amountMinor ?? 0;
      totalMinor += unit;
      entries.push({ serviceId: day.service_id, name: price?.name ?? '', unit, days: 1 });
    }
    lines.push({
      source: 'bed',
      count: due.length,
      totalMinor,
      accruing: true,
      parts: split(entries),
    });
  }
  const chargesMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0);
  const { rows: money } = await client.query<{ invoiced: string; paid: string }>(
    `select
       (select coalesce(sum(total_minor), 0) from charges
         where encounter_id = $1 and status = 'invoiced')::text as invoiced,
       (select coalesce(sum(paid_minor), 0) from invoices where encounter_id = $1)::text as paid`,
    [stay.encounter_id],
  );
  const applied = await sumOf(client, 'deposit_applications', stay.id);
  const paidMinor = num(money[0]?.paid) - applied;
  const depositsMinor =
    (await sumOf(client, 'deposits', stay.id)) - (await sumOf(client, 'deposit_refunds', stay.id));
  const { rows: estimate } = await client.query<{ amount_minor: string; note: string | null }>(
    'select amount_minor::text, note from stay_bill_estimates where admission_id = $1',
    [stay.id],
  );
  return {
    admissionId: stay.id,
    encounterId: stay.encounter_id,
    patientName: stay.patient_name,
    patientMrn: stay.patient_mrn,
    status: stay.status,
    asOf: new Date().toISOString(),
    lines,
    chargesMinor,
    invoicedMinor: num(money[0]?.invoiced),
    paidMinor,
    depositsMinor,
    balanceMinor: chargesMinor - depositsMinor - paidMinor,
    ...(estimate[0] ? { estimateMinor: num(estimate[0].amount_minor) } : {}),
    ...(estimate[0]?.note ? { estimateNote: estimate[0].note } : {}),
  };
}

async function settlement(client: pg.ClientBase, stay: StayRow) {
  const { rows: ledger } = await client.query<{ charges: string; unbilled: string }>(
    `select coalesce(sum(total_minor), 0)::text as charges,
       coalesce(sum(total_minor) filter (where status <> 'invoiced'), 0)::text as unbilled
     from charges where encounter_id = $1 and status <> 'void'`,
    [stay.encounter_id],
  );
  const { rows: invoices } = await client.query<{
    id: string;
    number: string | null;
    status: 'draft' | 'issued' | 'paid' | 'void';
    total_minor: string;
    credited_minor: string;
    paid_minor: string;
  }>(
    `select id, number, status, total_minor::text, credited_minor::text, paid_minor::text
     from invoices where encounter_id = $1 and status <> 'void'
     order by created_at, id`,
    [stay.encounter_id],
  );
  const issued = invoices.filter((invoice) => invoice.status !== 'draft');
  const total = (pick: (invoice: (typeof issued)[number]) => string) =>
    issued.reduce((sum, invoice) => sum + num(pick(invoice)), 0);
  const unbilledMinor = num(ledger[0]?.unbilled);
  // Bed days the hourly job has not posted yet are unbilled too (#170).
  const unposted = (await dueBedDays(client, stay.id, 1)).length > 0;
  const depositsMinor = await sumOf(client, 'deposits', stay.id);
  const depositsAppliedMinor = await sumOf(client, 'deposit_applications', stay.id);
  const depositsRefundedMinor = await sumOf(client, 'deposit_refunds', stay.id);
  const depositsHeldMinor = depositsMinor - depositsAppliedMinor - depositsRefundedMinor;
  const dueMinor = total((invoice) =>
    String(num(invoice.total_minor) - num(invoice.credited_minor) - num(invoice.paid_minor)),
  );
  const draft = invoices.some((invoice) => invoice.status === 'draft');
  const excessDepositMinor =
    unbilledMinor === 0 && !unposted && !draft ? Math.max(0, depositsHeldMinor - dueMinor) : 0;
  const reasons: ('unbilled' | 'draft_invoice' | 'balance_due' | 'excess_deposit')[] = [];
  if (unbilledMinor > 0 || unposted) reasons.push('unbilled');
  if (draft) reasons.push('draft_invoice');
  if (dueMinor > 0) reasons.push('balance_due');
  if (excessDepositMinor > 0) reasons.push('excess_deposit');
  return {
    admissionId: stay.id,
    patientName: stay.patient_name,
    patientMrn: stay.patient_mrn,
    status: stay.status,
    chargesMinor: num(ledger[0]?.charges),
    unbilledMinor,
    invoicedMinor: total((invoice) => invoice.total_minor),
    creditedMinor: total((invoice) => invoice.credited_minor),
    paidMinor: total((invoice) => invoice.paid_minor),
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
      totalMinor: num(invoice.total_minor),
      creditedMinor: num(invoice.credited_minor),
      paidMinor: num(invoice.paid_minor),
    })),
    policy: await policyOf(client),
    clearance: { cleared: reasons.length === 0, reasons },
  };
}

interface DepositRow {
  id: string;
  tenant_id: string;
  admission_id: string;
  amount_minor: string;
  method: 'cash' | 'card' | 'upi' | 'bank' | 'other';
  reference: string | null;
  recorded_by_name: string | null;
  at: Date;
}

const depositView = (row: DepositRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  admissionId: row.admission_id,
  amountMinor: num(row.amount_minor),
  method: row.method,
  ...(row.reference ? { reference: row.reference } : {}),
  recordedByName: row.recorded_by_name ?? '',
  at: row.at.toISOString(),
});

async function depositsOf(client: pg.ClientBase, admissionId: string, id?: string) {
  const { rows } = await client.query<DepositRow>(
    `select d.id, d.tenant_id, d.admission_id, d.amount_minor::text, d.method, d.reference,
       u.name as recorded_by_name, d.at
     from deposits d left join users u on u.id = d.recorded_by
     where d.admission_id = $1 and ($2::uuid is null or d.id = $2)
     order by d.at desc, d.id desc`,
    [admissionId, id ?? null],
  );
  return rows.map(depositView);
}

/** The caller's open register session, locked, for money in cash; 409 without one. */
async function cashSession(request: FastifyRequest): Promise<string> {
  const open = await openSessionOf(request.txClient, userIdOf(request));
  if (!open || !(await lockSession(request.txClient, open.id))) {
    throw new HttpError(409, 'no_open_register', 'Open a cash register session');
  }
  return open.id;
}

export const stayRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of STAY_SCHEMAS) app.addSchema(schema);

  const write = (permissions: Permission[]) =>
    ({
      permissions,
      feature: FEATURE,
      idempotent: { body: 'none', required: true },
    }) as const;

  app.get(
    '/admissions/:admissionId/bill',
    {
      config: { permissions: ['charge:read', 'admission:read'], feature: FEATURE },
      schema: {
        operationId: 'getRunningBill',
        tags: ['billing'],
        description:
          'The running bill of an inpatient stay (DS-03, #166): the charge ledger of the stay’s encounter added up by source, with the bed days accrued so far (a line with `accruing: true` that is not yet a ledger charge), the deposits taken (less those paid back), what was paid on invoices of the stay (deposits set against an invoice left out, so the balance counts a deposit once) and the estimate set at admission. `chargesMinor` is the sum of the lines (void charges left out); `balanceMinor` is charges less deposits and payments (negative: the patient is in credit). Needs charge:read, admission:read and the billing feature flag. Audited.',
        params: StayParams,
        response: { 200: ref(RunningBill), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'charge:read', 'admission:read');
      const stay = await findStay(
        request.txClient,
        (request.params as { admissionId: string }).admissionId,
      );
      request.audit('read', 'running_bill', stay.id);
      return runningBill(request.txClient, request.tx, stay);
    },
  );

  app.put(
    '/admissions/:admissionId/bill-estimate',
    {
      config: write(['invoice:create', 'charge:read', 'admission:read']),
      schema: {
        operationId: 'setBillEstimate',
        tags: ['billing'],
        headers: RequiredIdempotencyHeaders,
        description: `Sets or replaces the estimate of what the stay will cost, in minor units, with an optional note (up to ${ESTIMATE_NOTE_MAX} characters). The running bill then shows actual against estimate. The Idempotency-Key header is required. Needs invoice:create, charge:read, admission:read and the billing feature flag. Audited.`,
        params: StayParams,
        body: BillEstimateSet,
        response: { 200: ref(RunningBill), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:create', 'charge:read', 'admission:read');
      const stay = await findStay(
        request.txClient,
        (request.params as { admissionId: string }).admissionId,
      );
      if (request.replayOf === null) {
        const body = request.body as BillEstimateSet;
        const note = tidyOptional(body.note, ESTIMATE_NOTE_MAX);
        await request.txClient.query(
          `insert into stay_bill_estimates (tenant_id, admission_id, amount_minor, note, updated_by)
           values (app_tenant_id(), $1, $2, $3, $4)
           on conflict (tenant_id, admission_id) do update
             set amount_minor = excluded.amount_minor, note = excluded.note,
                 updated_by = excluded.updated_by, updated_at = now()`,
          [stay.id, body.amountMinor, note, userIdOf(request)],
        );
        request.audit('update', 'stay_bill_estimate', stay.id);
      }
      return runningBill(request.txClient, request.tx, stay);
    },
  );

  app.get(
    '/admissions/:admissionId/deposits',
    {
      config: { permissions: ['payment:read', 'admission:read'], feature: FEATURE },
      schema: {
        operationId: 'listDeposits',
        tags: ['billing'],
        description:
          'The deposits taken against a stay, newest first. Needs payment:read, admission:read (both with the scope all) and the billing feature flag.',
        params: StayParams,
        response: { 200: ref(DepositList), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'payment:read', 'admission:read');
      const stay = await findStay(
        request.txClient,
        (request.params as { admissionId: string }).admissionId,
      );
      return { items: await depositsOf(request.txClient, stay.id) };
    },
  );

  app.post(
    '/admissions/:admissionId/deposits',
    {
      config: write(['payment:create', 'admission:read']),
      schema: {
        operationId: 'takeDeposit',
        tags: ['billing'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Takes a deposit against a stay (cash goes into the caller’s open register session as a payment does: 409 `no_open_register`). A deposit is never edited or removed; it is set against the final invoice or paid back. A stay that is no longer admitted is 409 `stay_closed`. The Idempotency-Key header is required: a repeat takes nothing more. Needs payment:create and admission:read (both with the scope all) and the billing feature flag. Audited.',
        params: StayParams,
        body: DepositCreate,
        response: { 201: ref(Deposit), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply: FastifyReply) => {
      requireAll(request, 'payment:create', 'admission:read');
      const { admissionId } = request.params as { admissionId: string };
      const client = request.txClient;
      const stay = await findStay(client, admissionId, true);
      if (request.replayOf === null) {
        if (stay.status !== 'admitted') {
          throw new HttpError(409, 'stay_closed', 'The patient has been discharged');
        }
        const body = request.body as DepositCreate;
        const reference = body.reference ? tidyWithin(body.reference, DEPOSIT_REFERENCE_MAX) : '';
        const sessionId = body.method === 'cash' ? await cashSession(request) : null;
        const id = randomUUID();
        await client.query(
          `insert into deposits (id, tenant_id, admission_id, amount_minor, method, reference,
             session_id, recorded_by)
           values ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7)`,
          [
            id,
            stay.id,
            body.amountMinor,
            body.method,
            reference === '' ? null : reference,
            sessionId,
            userIdOf(request),
          ],
        );
        request.idempotentId = id;
        request.audit('create', 'deposit', id);
      }
      const made = (await depositsOf(client, stay.id, request.idempotentId ?? undefined))[0];
      if (!made) throw new HttpError(404, 'deposit_not_found', 'No such deposit');
      return reply.status(201).send(made);
    },
  );

  app.get(
    '/admissions/:admissionId/settlement',
    {
      config: { permissions: ['charge:read', 'admission:read'], feature: FEATURE },
      schema: {
        operationId: 'getStaySettlement',
        tags: ['billing'],
        description:
          'The final bill and settlement of an inpatient stay (DS-04, #167): the stay’s invoices, what is still to invoice, credit notes, payments, the deposits held, applied and refunded, what is due or refundable, and whether the patient may be discharged under the hospital’s policy. Needs charge:read, admission:read and the billing feature flag. Audited.',
        params: StayParams,
        response: { 200: ref(StaySettlement), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'charge:read', 'admission:read');
      const stay = await findStay(
        request.txClient,
        (request.params as { admissionId: string }).admissionId,
      );
      request.audit('read', 'stay_settlement', stay.id);
      return settlement(request.txClient, stay);
    },
  );

  app.post(
    '/admissions/:admissionId/deposits/apply',
    {
      config: write(['payment:create', 'charge:read', 'admission:read']),
      schema: {
        operationId: 'applyDeposits',
        tags: ['billing'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Sets the deposits held against an issued invoice of the stay as a payment: the lesser of what is held and what is due on it (a payment of method `other`, reference "Deposit", touching no register). 409 `no_deposit_held`, 409 `invoice_not_payable` (not an issued invoice of this stay, or nothing due on it). The Idempotency-Key header is required: a repeat applies nothing more. Needs payment:create, charge:read, admission:read and the billing feature flag. Audited.',
        params: StayParams,
        body: DepositApply,
        response: { 200: ref(StaySettlement), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'payment:create', 'charge:read', 'admission:read');
      const client = request.txClient;
      const stay = await findStay(
        client,
        (request.params as { admissionId: string }).admissionId,
        true,
      );
      if (request.replayOf === null) {
        const before = await settlement(client, stay);
        if (before.depositsHeldMinor < 1) {
          throw new HttpError(409, 'no_deposit_held', 'No deposit is held for this stay');
        }
        const locked = await lockInvoice(client, (request.body as DepositApply).invoiceId);
        const due = locked
          ? num(locked.total_minor) - num(locked.credited_minor) - num(locked.paid_minor)
          : 0;
        if (
          !locked ||
          locked.encounter_id !== stay.encounter_id ||
          locked.status !== 'issued' ||
          due < 1
        ) {
          throw new HttpError(
            409,
            'invoice_not_payable',
            'Only an issued invoice of the stay with something due takes it',
          );
        }
        const amount = Math.min(before.depositsHeldMinor, due);
        const paymentId = randomUUID();
        const userId = userIdOf(request);
        await insertPayment(client, {
          id: paymentId,
          invoiceId: locked.id,
          kind: 'payment',
          amountMinor: amount,
          method: 'other',
          reference: 'Deposit',
          refundOf: null,
          reason: null,
          sessionId: null,
          by: userId,
        });
        await client.query(
          `insert into deposit_applications (tenant_id, admission_id, invoice_id, payment_id,
             amount_minor, applied_by)
           values (app_tenant_id(), $1, $2, $3, $4, $5)`,
          [stay.id, locked.id, paymentId, amount, userId],
        );
        const paid = num(locked.paid_minor) + amount;
        const settled = paid + num(locked.credited_minor) === num(locked.total_minor);
        await updateSettlement(client, locked.id, {
          paid,
          credited: num(locked.credited_minor),
          status: settled ? 'paid' : 'issued',
        });
        request.audit('create', 'payment', paymentId);
        if (settled) {
          await request.emit('invoice.paid', locked.id, {
            invoiceId: locked.id,
            encounterId: locked.encounter_id,
            patientId: locked.patient_id,
          });
        }
      }
      return settlement(client, stay);
    },
  );

  app.post(
    '/admissions/:admissionId/deposits/refund',
    {
      config: write(['payment:refund', 'charge:read', 'admission:read']),
      schema: {
        operationId: 'refundDeposits',
        tags: ['billing'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Pays back the deposit held beyond what is due, in the mode chosen, with a reason. 409 `refund_exceeds` when the amount is more than the excess (which exists only when nothing is left to invoice and no draft is open); a cash refund comes out of the caller’s open register session (409 `no_open_register`). The Idempotency-Key header is required. Needs payment:refund, charge:read, admission:read and the billing feature flag. Audited.',
        params: StayParams,
        body: DepositRefund,
        response: { 200: ref(StaySettlement), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'payment:refund', 'charge:read', 'admission:read');
      const client = request.txClient;
      const stay = await findStay(
        client,
        (request.params as { admissionId: string }).admissionId,
        true,
      );
      if (request.replayOf === null) {
        const body = request.body as DepositRefund;
        const before = await settlement(client, stay);
        if (body.amountMinor > before.excessDepositMinor) {
          throw new HttpError(
            409,
            'refund_exceeds',
            'More than the deposit held beyond what is due',
          );
        }
        const reason = tidyWithin(body.reason, REASON_MAX);
        if (reason === '') throw new HttpError(400, 'validation_failed', 'A refund says why');
        const sessionId = body.method === 'cash' ? await cashSession(request) : null;
        const id = randomUUID();
        await client.query(
          `insert into deposit_refunds (id, tenant_id, admission_id, amount_minor, method, reason,
             session_id, refunded_by)
           values ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7)`,
          [id, stay.id, body.amountMinor, body.method, reason, sessionId, userIdOf(request)],
        );
        request.audit('create', 'deposit_refund', id);
      }
      return settlement(client, stay);
    },
  );

  app.get(
    '/billing/discharge-policy',
    {
      config: { permissions: ['invoice:read'], feature: FEATURE },
      schema: {
        operationId: 'getDischargePolicy',
        tags: ['billing'],
        description:
          'How the hospital gates discharge on the bill: `off`, `warn` (the person discharging confirms they have seen the bill) or `block` (nothing owed or unbilled); `warn` until set. Needs invoice:read and the billing feature flag.',
        response: { 200: ref(DischargePolicy), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      return { mode: await policyOf(request.txClient) };
    },
  );

  app.put(
    '/billing/discharge-policy',
    {
      config: write(['invoice:adjust', 'invoice:read']),
      schema: {
        operationId: 'setDischargePolicy',
        tags: ['billing'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Sets the policy. The Idempotency-Key header is required. Needs invoice:adjust, invoice:read and the billing feature flag. Audited.',
        body: DischargePolicy,
        response: { 200: ref(DischargePolicy), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:adjust', 'invoice:read');
      const { mode } = request.body as { mode: 'off' | 'warn' | 'block' };
      if (request.replayOf === null) {
        await request.txClient.query(
          `insert into billing_settings (tenant_id, discharge_policy, updated_by)
           values (app_tenant_id(), $1, $2)
           on conflict (tenant_id)
           do update set discharge_policy = excluded.discharge_policy,
             updated_by = excluded.updated_by, updated_at = now()`,
          [mode, userIdOf(request)],
        );
        request.audit('update', 'billing_settings');
      }
      return { mode: await policyOf(request.txClient) };
    },
  );
};

/**
 * The hospital's discharge bill policy, enforced when admissions asks (#790). `off`, billing off
 * for the hospital, or a bill with nothing open lets the discharge through. Under `block` the
 * caller must hold `invoice:adjust` and have confirmed; under `warn` anyone must have confirmed.
 */
export const billDischargeGate: DischargeGate = async (request, stay) => {
  const policy = await request.access.policy();
  if (policy?.features[FEATURE] !== true) return;
  const client = request.txClient;
  const mode = await policyOf(client);
  if (mode === 'off') return;
  const found = await findStay(client, stay.admissionId);
  if ((await settlement(client, found)).clearance.cleared) return;
  if (mode === 'block') {
    const mayOverride = policy.permissions.some((grant) => grant.permission === 'invoice:adjust');
    if (!(mayOverride && stay.acknowledged)) {
      throw new HttpError(409, 'bill_outstanding', 'The bill of the stay is not settled');
    }
    request.audit('override', 'discharge_bill_policy', stay.admissionId);
    return;
  }
  if (!stay.acknowledged) {
    throw new HttpError(409, 'bill_unconfirmed', 'Confirm discharging with the bill unsettled');
  }
};
