import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  findPayment,
  creditNotesOf,
  insertCreditNote,
  insertPayment,
  isUuid,
  lockInvoice,
  lockSession,
  nextNumber,
  num,
  openSessionOf,
  refundableOf,
  releaseCharges,
  updateSettlement,
  type LockedInvoice,
} from './repository.js';
import {
  CreditNote,
  CreditNoteCreate,
  CreditNoteList,
  Payment,
  PaymentCreate,
  PaymentList,
  REASON_MAX,
  REFERENCE_MAX,
  RefundCreate,
} from './schemas.js';
import {
  creditNotesAnswer,
  creditNoteView,
  FEATURE,
  invoiceNotFound,
  paymentsAnswer,
  paymentView,
  requireAll,
  userIdOf,
} from './views.js';

const InvoiceParams = Type.Object({ invoiceId: Type.String({ maxLength: 64 }) });
const PaymentParams = Type.Object({ paymentId: Type.String({ maxLength: 64 }) });

const ids = (invoice: LockedInvoice) => ({
  invoiceId: invoice.id,
  encounterId: invoice.encounter_id,
  patientId: invoice.patient_id,
});

/** What a lock on an issued, unpaid-or-paid invoice shows: the money left to take. */
const dueOf = (invoice: LockedInvoice) =>
  num(invoice.total_minor) - num(invoice.credited_minor) - num(invoice.paid_minor);

/**
 * Payments, refunds and credit notes (#114). Each takes the invoice's row lock first, so two
 * payments never both see the same amount due; the payment, refund and credit note rows are
 * append-only, and the invoice keeps the running sums.
 */
export const paymentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** The invoice, locked, which must have been issued and not made void. */
  async function lockLive(invoiceId: string, request: Parameters<typeof requireAll>[0]) {
    const locked = await lockInvoice(request.txClient, invoiceId);
    if (!locked) throw invoiceNotFound();
    if (locked.status === 'draft' || locked.status === 'void') {
      throw new HttpError(409, 'invoice_not_payable', 'The invoice is not open for money');
    }
    return locked;
  }

  app.get(
    '/invoices/:invoiceId/payments',
    {
      config: { permissions: ['payment:read'], feature: FEATURE },
      schema: {
        operationId: 'listInvoicePayments',
        tags: ['billing'],
        description:
          'Every payment and refund of an invoice, oldest first (#114). Requires payment:read with the scope `all` and the billing feature flag. Audited.',
        params: InvoiceParams,
        response: { 200: ref(PaymentList), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'payment:read');
      const { invoiceId } = request.params as { invoiceId: string };
      const { rows } = await request.txClient.query('select 1 from invoices where id = $1', [
        isUuid(invoiceId) ? invoiceId : '00000000-0000-0000-0000-000000000000',
      ]);
      if (rows.length === 0) throw invoiceNotFound();
      request.audit('read', 'payment', invoiceId);
      return { items: await paymentsAnswer(request, invoiceId) };
    },
  );

  async function replayPayment(request: Parameters<typeof requireAll>[0], reply: FastifyReply) {
    const id = request.idempotentId;
    const row = id ? await findPayment(request.txClient, id) : null;
    if (!row) throw new HttpError(404, 'payment_not_found', 'No such payment');
    request.audit('read', 'payment', row.id);
    return reply.status(201).send(paymentView(row));
  }

  app.post(
    '/invoices/:invoiceId/payments',
    {
      config: {
        permissions: ['payment:create', 'payment:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'recordPayment',
        tags: ['billing'],
        description:
          'Records a payment against an issued invoice (#114). Never more than is still due (409 `overpayment`); an invoice that is a draft, void or already paid is refused (409 `invoice_not_payable`). Cash goes into the caller’s open cash register session (409 `no_open_register` without one). The invoice becomes paid when nothing is due, and `invoice.paid` is emitted. The Idempotency-Key header is required: a repeat records nothing more and answers with the payment. Requires payment:create and payment:read with the scope `all` and the billing feature flag. Audited.',
        params: InvoiceParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(PaymentCreate),
        response: { 201: ref(Payment), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      requireAll(request, 'payment:create', 'payment:read');
      if (request.replayOf !== null) return replayPayment(request, reply);
      const { invoiceId } = request.params as { invoiceId: string };
      const body = request.body as PaymentCreate;
      const client = request.txClient;
      const locked = await lockLive(invoiceId, request);
      if (locked.status === 'paid' || dueOf(locked) <= 0) {
        throw new HttpError(409, 'invoice_not_payable', 'Nothing is due on the invoice');
      }
      if (body.amountMinor > dueOf(locked)) {
        throw new HttpError(409, 'overpayment', 'More than is due');
      }
      const reference = body.reference ? tidyWithin(body.reference, REFERENCE_MAX) : null;
      const userId = userIdOf(request);
      let sessionId: string | null = null;
      if (body.method === 'cash') {
        const open = await openSessionOf(client, userId);
        if (!open) throw new HttpError(409, 'no_open_register', 'Open a cash register session');
        if (!(await lockSession(client, open.id))) {
          throw new HttpError(409, 'no_open_register', 'Open a cash register session');
        }
        sessionId = open.id;
      }
      const id = randomUUID();
      await insertPayment(client, {
        id,
        invoiceId: locked.id,
        kind: 'payment',
        amountMinor: body.amountMinor,
        method: body.method,
        reference: reference === '' ? null : reference,
        refundOf: null,
        reason: null,
        sessionId,
        by: userId,
      });
      const paid = num(locked.paid_minor) + body.amountMinor;
      const settled = paid + num(locked.credited_minor) === num(locked.total_minor);
      await updateSettlement(client, locked.id, {
        paid,
        credited: num(locked.credited_minor),
        status: settled ? 'paid' : 'issued',
      });
      request.idempotentId = id;
      request.audit('create', 'payment', id);
      if (settled) await request.emit('invoice.paid', locked.id, ids(locked));
      return replayPayment(request, reply);
    },
  );

  app.post(
    '/payments/:paymentId/refunds',
    {
      config: {
        permissions: ['payment:refund', 'payment:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'refundPayment',
        tags: ['billing'],
        description:
          'Refunds some or all of a payment, with a reason (#114): a new entry on the invoice, the payment itself never changes. Never more than the payment still holds (409 `refund_exceeds`). A paid invoice becomes issued again. A cash refund comes out of the caller’s open cash register session (409 `no_open_register`). Emits `payment.refunded`. The Idempotency-Key header is required. Requires payment:refund and payment:read with the scope `all` and the billing feature flag. Audited.',
        params: PaymentParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(RefundCreate),
        response: { 201: ref(Payment), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      requireAll(request, 'payment:refund', 'payment:read');
      if (request.replayOf !== null) return replayPayment(request, reply);
      const { paymentId } = request.params as { paymentId: string };
      const body = request.body as { amountMinor: number; reason: string };
      const client = request.txClient;
      const payment = await findPayment(client, paymentId);
      if (!payment || payment.kind !== 'payment') {
        throw new HttpError(404, 'payment_not_found', 'No such payment');
      }
      const locked = await lockInvoice(client, payment.invoice_id);
      if (!locked) throw invoiceNotFound();
      // A deposit set against an invoice is paid back through the deposit refund, which keeps the
      // deposit ledger right (#170).
      const { rows: applied } = await client.query(
        'select 1 from deposit_applications where payment_id = $1',
        [payment.id],
      );
      if (applied.length > 0) {
        throw new HttpError(409, 'deposit_payment', 'A deposit payment is refunded as a deposit');
      }
      if (body.amountMinor > (await refundableOf(client, payment.id))) {
        throw new HttpError(409, 'refund_exceeds', 'More than the payment still holds');
      }
      const reason = tidyWithin(body.reason, REASON_MAX);
      if (reason === '') throw new HttpError(400, 'validation_failed', 'A refund says why');
      const userId = userIdOf(request);
      let sessionId: string | null = null;
      if (payment.method === 'cash') {
        const open = await openSessionOf(client, userId);
        if (!open) throw new HttpError(409, 'no_open_register', 'Open a cash register session');
        if (!(await lockSession(client, open.id))) {
          throw new HttpError(409, 'no_open_register', 'Open a cash register session');
        }
        sessionId = open.id;
      }
      const id = randomUUID();
      await insertPayment(client, {
        id,
        invoiceId: locked.id,
        kind: 'refund',
        amountMinor: body.amountMinor,
        method: payment.method,
        reference: null,
        refundOf: payment.id,
        reason,
        sessionId,
        by: userId,
      });
      await updateSettlement(client, locked.id, {
        paid: num(locked.paid_minor) - body.amountMinor,
        credited: num(locked.credited_minor),
        status: locked.status === 'void' ? 'void' : 'issued',
      });
      request.idempotentId = id;
      request.audit('create', 'payment', id);
      await request.emit('payment.refunded', id, { ...ids(locked), paymentId: payment.id });
      return replayPayment(request, reply);
    },
  );

  app.get(
    '/invoices/:invoiceId/credit-notes',
    {
      config: { permissions: ['invoice:read'], feature: FEATURE },
      schema: {
        operationId: 'listInvoiceCreditNotes',
        tags: ['billing'],
        description:
          'The credit notes against an invoice, oldest first (#114). Requires invoice:read with the scope `all` and the billing feature flag. Audited.',
        params: InvoiceParams,
        response: { 200: ref(CreditNoteList), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      const { invoiceId } = request.params as { invoiceId: string };
      const { rows } = await request.txClient.query('select 1 from invoices where id = $1', [
        isUuid(invoiceId) ? invoiceId : '00000000-0000-0000-0000-000000000000',
      ]);
      if (rows.length === 0) throw invoiceNotFound();
      request.audit('read', 'credit_note', invoiceId);
      return { items: await creditNotesAnswer(request, invoiceId) };
    },
  );

  app.post(
    '/invoices/:invoiceId/credit-notes',
    {
      config: {
        permissions: ['creditNote:create', 'invoice:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createCreditNote',
        tags: ['billing'],
        description:
          'Issues a credit note against an issued invoice, with a reason (#114): it gets the next number of its own series, and the invoice itself never changes. Never more than is left after earlier credit notes (409 `credit_exceeds`), and not while the money paid would then exceed what remains owed (409 `refund_first`). A credit note for the whole invoice makes it void and lets its charges go back to pending, to be billed again. Emits `invoice.credited`. The Idempotency-Key header is required. Requires creditNote:create and invoice:read with the scope `all` and the billing feature flag. Audited.',
        params: InvoiceParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(CreditNoteCreate),
        response: { 201: ref(CreditNote), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      requireAll(request, 'creditNote:create', 'invoice:read');
      const replay = async () => {
        const noteId = request.idempotentId;
        const { invoiceId } = request.params as { invoiceId: string };
        const note = (await creditNotesOf(request.txClient, invoiceId)).find(
          (each) => each.id === noteId,
        );
        if (!note) throw new HttpError(404, 'credit_note_not_found', 'No such credit note');
        request.audit('read', 'credit_note', note.id);
        return reply.status(201).send(creditNoteView(note));
      };
      if (request.replayOf !== null) return replay();
      const { invoiceId } = request.params as { invoiceId: string };
      const body = request.body as { amountMinor: number; reason: string };
      const client = request.txClient;
      const locked = await lockLive(invoiceId, request);
      const total = num(locked.total_minor);
      const credited = num(locked.credited_minor);
      if (body.amountMinor > total - credited) {
        throw new HttpError(409, 'credit_exceeds', 'More than is left of the invoice');
      }
      const after = credited + body.amountMinor;
      if (num(locked.paid_minor) > total - after) {
        throw new HttpError(409, 'refund_first', 'Refund the money paid first');
      }
      const reason = tidyWithin(body.reason, REASON_MAX);
      if (reason === '') throw new HttpError(400, 'validation_failed', 'A credit note says why');
      const { number, fiscalYear } = await nextNumber(client, 'credit_note');
      const id = randomUUID();
      await insertCreditNote(client, {
        id,
        invoiceId: locked.id,
        number,
        fiscalYear,
        amountMinor: body.amountMinor,
        reason,
        by: userIdOf(request),
      });
      const paid = num(locked.paid_minor);
      const whole = after === total;
      const status = whole ? 'void' : paid + after === total ? 'paid' : 'issued';
      await updateSettlement(client, locked.id, { paid, credited: after, status });
      if (whole) await releaseCharges(client, locked.id);
      request.idempotentId = id;
      request.audit('create', 'credit_note', id);
      await request.emit('invoice.credited', locked.id, { ...ids(locked), creditNoteId: id });
      if (status === 'paid' && locked.status !== 'paid') {
        await request.emit('invoice.paid', locked.id, ids(locked));
      }
      return replay();
    },
  );
};
