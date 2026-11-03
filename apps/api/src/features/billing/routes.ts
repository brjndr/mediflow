import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  claimCharges,
  findEncounter,
  holdCharges,
  insertDraft,
  isUuid,
  issueInvoice,
  listCharges,
  listInvoices,
  lockInvoice,
  manualLinesOf,
  nextNumber,
  replaceLines,
  setDraftTotal,
  num,
} from './repository.js';
import {
  BILLING_SCHEMAS,
  ChargePage,
  ChargeQuery,
  DESCRIPTION_MAX,
  Invoice,
  InvoiceContent,
  InvoiceIssue,
  InvoicePage,
  InvoiceUpdate,
  type ManualLine,
} from './schemas.js';
import {
  chargeView,
  FEATURE,
  invoiceAnswer,
  invoiceNotFound,
  invoiceView,
  requireAll,
  userIdOf,
} from './views.js';
import { CursorQuery } from '../../core/http/schemas.js';
import { paymentRoutes } from './payment-routes.js';
import { registerRoutes } from './register-routes.js';

const EncounterParams = Type.Object({ encounterId: Type.String({ maxLength: 64 }) });
const InvoiceParams = Type.Object({ invoiceId: Type.String({ maxLength: 64 }) });
const INVOICE_PAGE_QUERY = CursorQuery;

const encounterNotFound = () => new HttpError(404, 'encounter_not_found', 'No such visit');
const versionConflict = () =>
  new HttpError(409, 'version_conflict', 'The invoice was changed by someone else');

/**
 * Billing (#114): the charges of a visit, invoices assembled from them, issued with a number of
 * the fiscal year and never changed after, payments and refunds, credit notes and cash register
 * sessions. A module never writes an invoice: charges are posted from events (`posting.ts`).
 */
export const billingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of BILLING_SCHEMAS) app.addSchema(schema);

  /** What a draft is made of, checked and written: its lines, its charges and its total. */
  async function fillDraft(
    request: FastifyRequest,
    invoice: { id: string; encounterId: string },
    content: { chargeIds: string[]; manualLines: ManualLine[] },
    typedBefore: ManualLine[],
    bump: boolean,
  ): Promise<void> {
    const client = request.txClient;
    if (content.chargeIds.length === 0 && content.manualLines.length === 0) {
      throw new HttpError(422, 'empty_invoice', 'An invoice has at least one line');
    }
    const chargeIds = content.chargeIds.map((id) => id.toLowerCase());
    if (chargeIds.some((id) => !isUuid(id)) || new Set(chargeIds).size !== chargeIds.length) {
      throw new HttpError(409, 'charge_unavailable', 'A charge is not there to be billed');
    }
    const manual = content.manualLines.map((line) => ({
      description: tidyWithin(line.description, DESCRIPTION_MAX),
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
    }));
    if (manual.some((line) => line.description === '')) {
      throw new HttpError(400, 'validation_failed', 'A line says what it is for');
    }
    // A typed line skips the price list and the charge ledger: whoever may not adjust keeps the
    // lines a draft already has and adds none.
    const same = JSON.stringify(manual) === JSON.stringify(typedBefore);
    const policy = await request.access.policy();
    const mayAdjust = policy?.permissions.some(
      (grant) => grant.permission === 'invoice:adjust' && (grant.scope ?? 'all') === 'all',
    );
    if (manual.length > 0 && !same && !mayAdjust) {
      throw new HttpError(403, 'permission_denied', 'Typed lines need invoice:adjust');
    }
    const held =
      chargeIds.length > 0
        ? await claimCharges(client, invoice.id, invoice.encounterId, chargeIds)
        : [];
    if (held.length !== chargeIds.length) {
      throw new HttpError(409, 'charge_unavailable', 'A charge is not there to be billed');
    }
    // Lines in the order the person chose the charges.
    const byId = new Map(held.map((charge) => [charge.id, charge]));
    const ordered = chargeIds.flatMap((id) => {
      const charge = byId.get(id);
      return charge ? [charge] : [];
    });
    await holdCharges(client, invoice.id, chargeIds);
    const total = await replaceLines(client, invoice.id, ordered, manual);
    if (!Number.isSafeInteger(total)) {
      throw new HttpError(422, 'amount_too_large', 'The invoice is too large');
    }
    await setDraftTotal(client, invoice.id, total, bump);
  }

  app.get(
    '/encounters/:encounterId/charges',
    {
      config: { permissions: ['charge:read'], feature: FEATURE },
      schema: {
        operationId: 'listEncounterCharges',
        tags: ['billing'],
        description:
          'The charges posted to a visit (#114), newest first, optionally of one status. Posted by the API from completed orders and dispenses, priced when posted. Requires charge:read with the scope `all` and the billing feature flag. Audited.',
        params: EncounterParams,
        querystring: ChargeQuery,
        response: { 200: ref(ChargePage), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'charge:read');
      const { encounterId } = request.params as { encounterId: string };
      const query = request.query as { status?: string; cursor?: string; limit: number };
      if (!(await findEncounter(request.txClient, encounterId))) throw encounterNotFound();
      const page = await listCharges(request.txClient, { encounterId, ...query });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
      request.audit('read', 'charge', encounterId);
      return {
        items: page.rows.map(chargeView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.get(
    '/encounters/:encounterId/invoices',
    {
      config: { permissions: ['invoice:read'], feature: FEATURE },
      schema: {
        operationId: 'listEncounterInvoices',
        tags: ['billing'],
        description:
          'The invoices of a visit (#114), newest first, drafts included. Requires invoice:read with the scope `all` and the billing feature flag. Audited.',
        params: EncounterParams,
        querystring: INVOICE_PAGE_QUERY,
        response: { 200: ref(InvoicePage), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      const { encounterId } = request.params as { encounterId: string };
      const query = request.query as { cursor?: string; limit: number };
      if (!(await findEncounter(request.txClient, encounterId))) throw encounterNotFound();
      const page = await listInvoices(request.txClient, { encounterId, ...query });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
      request.audit('read', 'invoice', encounterId);
      return {
        items: page.rows.map(invoiceView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/encounters/:encounterId/invoices',
    {
      config: {
        permissions: ['invoice:create', 'invoice:read', 'charge:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createInvoice',
        tags: ['billing'],
        description:
          'Makes a draft invoice of a visit from some of its pending charges and lines typed in (#114). The server works out every line and the total; a client total is never read. A charge sits in one draft at a time (409 `charge_unavailable`, also for one that is not pending or not of this visit). Typed lines need invoice:adjust (403). A cancelled visit has nothing to bill (409 `encounter_cancelled`). The Idempotency-Key header is required: a repeat makes no second draft and answers with the draft as it is now. Requires invoice:create, invoice:read and charge:read with the scope `all` and the billing feature flag. Audited.',
        params: EncounterParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(InvoiceContent),
        response: { 201: ref(Invoice), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply: FastifyReply) => {
      requireAll(request, 'invoice:create', 'invoice:read', 'charge:read');
      if (request.replayOf !== null) {
        if (!request.idempotentId) throw invoiceNotFound();
        return reply.status(201).send(await invoiceAnswer(request, request.idempotentId));
      }
      const { encounterId } = request.params as { encounterId: string };
      const body = request.body as InvoiceContent;
      const encounter = await findEncounter(request.txClient, encounterId);
      if (!encounter) throw encounterNotFound();
      if (encounter.status === 'cancelled') {
        throw new HttpError(409, 'encounter_cancelled', 'A cancelled visit has nothing to bill');
      }
      const id = randomUUID();
      await insertDraft(request.txClient, {
        id,
        encounterId: encounter.id,
        patientId: encounter.patient_id,
        createdBy: userIdOf(request),
      });
      await fillDraft(request, { id, encounterId: encounter.id }, body, [], false);
      request.idempotentId = id;
      request.audit('create', 'invoice', id);
      return reply.status(201).send(await invoiceAnswer(request, id));
    },
  );

  app.get(
    '/invoices/:invoiceId',
    {
      config: { permissions: ['invoice:read'], feature: FEATURE },
      schema: {
        operationId: 'getInvoice',
        tags: ['billing'],
        description:
          'An invoice with its lines (#114). Requires invoice:read with the scope `all` and the billing feature flag. Audited.',
        params: InvoiceParams,
        response: { 200: ref(Invoice), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      return invoiceAnswer(request, (request.params as { invoiceId: string }).invoiceId);
    },
  );

  app.patch(
    '/invoices/:invoiceId',
    {
      config: {
        permissions: ['invoice:create', 'invoice:read', 'charge:read'],
        feature: FEATURE,
        idempotent: { body: 'none' },
      },
      schema: {
        operationId: 'updateInvoice',
        tags: ['billing'],
        description:
          'Changes what a draft is made of (#114): the charges and typed lines it now holds, with the version the edit started from (409 `version_conflict`). The charges left out go back to pending. An issued invoice is never changed (409 `invoice_not_draft`). Typed lines need invoice:adjust unless they are the lines the draft already has. Accepts an Idempotency-Key. Requires invoice:create, invoice:read and charge:read with the scope `all` and the billing feature flag. Audited.',
        params: InvoiceParams,
        headers: IdempotencyHeaders,
        body: ref(InvoiceUpdate),
        response: { 200: ref(Invoice), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:create', 'invoice:read', 'charge:read');
      const { invoiceId } = request.params as { invoiceId: string };
      if (request.replayOf !== null) return invoiceAnswer(request, invoiceId);
      const body = request.body as InvoiceUpdate;
      const locked = await lockInvoice(request.txClient, invoiceId);
      if (!locked) throw invoiceNotFound();
      if (locked.status !== 'draft') {
        throw new HttpError(409, 'invoice_not_draft', 'An issued invoice is never changed');
      }
      if (locked.version !== body.version) throw versionConflict();
      const typedBefore = await manualLinesOf(request.txClient, locked.id);
      await fillDraft(
        request,
        { id: locked.id, encounterId: locked.encounter_id },
        body,
        typedBefore,
        true,
      );
      request.idempotentId = locked.id;
      request.audit('update', 'invoice', locked.id);
      return invoiceAnswer(request, locked.id);
    },
  );

  app.post(
    '/invoices/:invoiceId/issue',
    {
      config: {
        permissions: ['invoice:issue', 'invoice:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'issueInvoice',
        tags: ['billing'],
        description:
          'Issues a draft (#114): it gets the next number of the fiscal year (April to March, gapless), its charges become invoiced, and it is never changed again. The version must be the one the person saw (409 `version_conflict`); an invoice with no lines is refused (409 `invoice_empty`); one holding a charge flagged as brought back is refused until it is taken off (409 `charge_returned`); one already issued is refused (409 `invoice_not_draft`). Emits `invoice.issued`, and `invoice.paid` for an invoice of nothing to pay. The Idempotency-Key header is required: a repeat issues nothing more and answers with the invoice as it is now. Requires invoice:issue and invoice:read with the scope `all` and the billing feature flag. Audited.',
        params: InvoiceParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(InvoiceIssue),
        response: { 200: ref(Invoice), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:issue', 'invoice:read');
      const { invoiceId } = request.params as { invoiceId: string };
      if (request.replayOf !== null) return invoiceAnswer(request, invoiceId);
      const body = request.body as { version: number };
      const client = request.txClient;
      const locked = await lockInvoice(client, invoiceId);
      if (!locked) throw invoiceNotFound();
      if (locked.status !== 'draft') {
        throw new HttpError(409, 'invoice_not_draft', 'The invoice is already issued');
      }
      if (locked.version !== body.version) throw versionConflict();
      const { rows } = await client.query<{ lines: number }>(
        'select count(*)::int as lines from invoice_lines where invoice_id = $1',
        [locked.id],
      );
      if ((rows[0]?.lines ?? 0) === 0) {
        throw new HttpError(409, 'invoice_empty', 'An invoice with no lines is not issued');
      }
      const returned = await client.query(
        "select 1 from charges where invoice_id = $1 and flag = 'return_review'",
        [locked.id],
      );
      if ((returned.rowCount ?? 0) > 0) {
        throw new HttpError(409, 'charge_returned', 'A charge on the invoice was brought back');
      }
      const { number, fiscalYear } = await nextNumber(client, 'invoice');
      const nothingToPay = num(locked.total_minor) === 0;
      await issueInvoice(client, {
        id: locked.id,
        number,
        fiscalYear,
        by: userIdOf(request),
        paid: nothingToPay,
      });
      request.idempotentId = locked.id;
      request.audit('update', 'invoice', locked.id);
      const ids = {
        invoiceId: locked.id,
        encounterId: locked.encounter_id,
        patientId: locked.patient_id,
      };
      await request.emit('invoice.issued', locked.id, ids);
      if (nothingToPay) await request.emit('invoice.paid', locked.id, ids);
      return invoiceAnswer(request, locked.id);
    },
  );

  await app.register(paymentRoutes);
  await app.register(registerRoutes);
};
