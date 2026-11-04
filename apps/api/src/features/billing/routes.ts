import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  claimCharges,
  findCharge,
  findInvoice,
  findEncounter,
  holdCharges,
  insertDraft,
  isUuid,
  issueInvoice,
  listCharges,
  listInvoices,
  lockInvoice,
  manualLinesOf,
  type ManualLineInput,
  nextNumber,
  replaceLines,
  searchInvoices,
  setDraftState,
  type DraftDiscountState,
  discountsOf,
  num,
} from './repository.js';
import type { ChargeDiscount, Discount } from './schemas.js';
import {
  BILLING_SCHEMAS,
  Charge,
  ChargeCreate,
  ChargePage,
  ChargeQuery,
  DESCRIPTION_MAX,
  Invoice,
  InvoiceContent,
  InvoiceIssue,
  InvoiceListQuery,
  InvoiceSearch,
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
import { aboveLimit, discountLimitOf, type DiscountInput } from './discount.js';
import { postCharge, priceOf } from './posting.js';
import { paymentRoutes } from './payment-routes.js';
import { registerRoutes } from './register-routes.js';
import { discountRoutes } from './discount-routes.js';
import { taxRoutes } from './tax-routes.js';
import { packageRoutes } from './package-routes.js';

const EncounterParams = Type.Object({ encounterId: Type.String({ maxLength: 64 }) });
const InvoiceParams = Type.Object({ invoiceId: Type.String({ maxLength: 64 }) });

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

  /** Whether the caller holds a permission at the scope `all`, which is all billing looks at. */
  async function holds(request: FastifyRequest, permission: string): Promise<boolean> {
    const policy = await request.access.policy();
    return (
      policy?.permissions.some(
        (grant) => grant.permission === permission && (grant.scope ?? 'all') === 'all',
      ) ?? false
    );
  }

  /** What a draft is made of, checked and written: its lines, its charges and its total. */
  async function fillDraft(
    request: FastifyRequest,
    invoice: { id: string; encounterId: string },
    content: {
      chargeIds: string[];
      manualLines: ManualLine[];
      chargeDiscounts?: ChargeDiscount[];
      billDiscount?: Discount;
    },
    typedBefore: ManualLineInput[],
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
    const manual: ManualLineInput[] = content.manualLines.map((line) => ({
      description: tidyWithin(line.description, DESCRIPTION_MAX),
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      taxClass: line.taxClass ?? null,
      discount: line.discount ?? null,
    }));
    if (manual.some((line) => line.description === '')) {
      throw new HttpError(400, 'validation_failed', 'A line says what it is for');
    }
    const chargeDiscount = new Map<string, DiscountInput>();
    for (const entry of content.chargeDiscounts ?? []) {
      const id = entry.chargeId.toLowerCase();
      if (!chargeIds.includes(id) || chargeDiscount.has(id)) {
        throw new HttpError(
          400,
          'validation_failed',
          'A discount names a charge on the bill, once',
        );
      }
      chargeDiscount.set(id, entry.discount);
    }
    // A typed line skips the price list and the charge ledger: whoever may not adjust keeps the
    // lines a draft already has and adds none. A discount on it is a matter of discount:apply.
    const plain = (lines: ManualLineInput[]) =>
      JSON.stringify(lines.map(({ discount: _discount, ...line }) => line));
    const sameTyped = plain(manual) === plain(typedBefore);
    if (manual.length > 0 && !sameTyped && !(await holds(request, 'invoice:adjust'))) {
      throw new HttpError(403, 'permission_denied', 'Typed lines need invoice:adjust');
    }
    // Giving, changing or taking away a discount needs discount:apply; saving a draft with the
    // discounts it already has does not.
    const existing = await discountsOf(client, invoice.id);
    const bill = content.billDiscount ?? null;
    // Compared field by field, so the order of keys in the body decides nothing. What a draft
    // had on a charge now taken off it counts too: it is a discount that goes.
    const text = (discount: DiscountInput | null | undefined) =>
      discount ? `${discount.kind}:${discount.value}:${discount.reason}` : '-';
    const everyCharge = [...new Set([...chargeIds, ...Object.keys(existing.charges)])].sort();
    const asked = JSON.stringify({
      charges: everyCharge.map((id) => text(chargeDiscount.get(id))),
      manual: manual.map((line) => text(line.discount)),
      bill: text(bill),
    });
    const before = JSON.stringify({
      charges: everyCharge.map((id) => text(existing.charges[id])),
      manual: typedBefore.map((line) => text(line.discount)),
      bill: text(existing.bill),
    });
    const discountsChanged = asked !== before;
    if (discountsChanged && !(await holds(request, 'discount:apply'))) {
      throw new HttpError(403, 'permission_denied', 'Discounts need discount:apply');
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
      return charge ? [{ ...charge, discount: chargeDiscount.get(id) ?? null }] : [];
    });
    await holdCharges(client, invoice.id, chargeIds);
    const amounts = await replaceLines(client, invoice.id, ordered, manual, bill);
    if (!Number.isSafeInteger(amounts.totalMinor) || !Number.isSafeInteger(amounts.grossMinor)) {
      throw new HttpError(422, 'amount_too_large', 'The invoice is too large');
    }
    // A discount above the hospital's limit waits for a second person. An approval stands only
    // for the amount that was approved; any other amount above the limit is asked for again.
    const userId = userIdOf(request);
    const aboveTheLimit =
      amounts.discountMinor > 0 &&
      aboveLimit(
        BigInt(amounts.discountMinor),
        BigInt(amounts.grossMinor),
        await discountLimitOf(client),
      );
    let status: DraftDiscountState['status'] = 'none';
    // Whoever last changed the discount stays its maker for as long as there is one, even
    // within the limit, so lowering the limit later cannot make the maker the approver.
    let appliedBy: string | null = null;
    if (amounts.discountMinor > 0) {
      const unchanged =
        !discountsChanged &&
        existing.discountMinor === amounts.discountMinor &&
        existing.appliedBy !== null;
      appliedBy = unchanged ? existing.appliedBy : userId;
      if (aboveTheLimit) {
        // An approval stands only for the discount and the bill it was given on.
        const stands =
          existing.status === 'approved' &&
          !discountsChanged &&
          existing.approvedMinor === amounts.discountMinor &&
          existing.approvedGrossMinor === amounts.grossMinor;
        status = stands ? 'approved' : 'pending';
      }
    }
    await setDraftState(client, invoice.id, amounts, { bill, status, appliedBy }, bump);
    if (discountsChanged) request.audit('discount', 'invoice', invoice.id);
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
      const query = request.query as { status?: string; cursor?: string; limit?: number };
      if (!(await findEncounter(request.txClient, encounterId))) throw encounterNotFound();
      const page = await listCharges(request.txClient, {
        encounterId,
        ...query,
        limit: query.limit ?? 25,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
      request.audit('read', 'charge', encounterId);
      return {
        items: page.rows.map(chargeView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/encounters/:encounterId/charges',
    {
      config: {
        permissions: ['charge:create', 'charge:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createEncounterCharge',
        tags: ['billing'],
        description:
          'Charges a service of the price catalog to a visit by hand (#115): it is posted to the ledger as a pending charge, source `service`, at the standard price list price in effect today, which the client never sends. An unknown service is 404 `service_not_found`; an archived one is 409 `service_archived` and one with no price in effect 409 `no_price` (work already done is posted at the last price by the events, but a charge typed in is a choice and is refused); a cancelled visit 409 `encounter_cancelled`. The Idempotency-Key header is required: a repeat posts nothing more and answers with the charge as it is now. Emits `charge.posted`. Requires charge:create and charge:read with the scope `all` and the billing feature flag. Audited.',
        params: EncounterParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(ChargeCreate),
        response: { 201: ref(Charge), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply: FastifyReply) => {
      requireAll(request, 'charge:create', 'charge:read');
      const answer = async (id: string) => {
        const row = await findCharge(request.txClient, id);
        if (!row || row.encounter_id !== (request.params as { encounterId: string }).encounterId) {
          throw new HttpError(404, 'charge_not_found', 'No such charge');
        }
        return reply.status(201).send(chargeView(row));
      };
      if (request.replayOf !== null) {
        if (!request.idempotentId) throw new HttpError(404, 'charge_not_found', 'No such charge');
        return answer(request.idempotentId);
      }
      const { encounterId } = request.params as { encounterId: string };
      const body = request.body as ChargeCreate;
      const encounter = await findEncounter(request.txClient, encounterId);
      if (!encounter) throw encounterNotFound();
      if (encounter.status === 'cancelled') {
        throw new HttpError(409, 'encounter_cancelled', 'A cancelled visit has nothing to bill');
      }
      const service = isUuid(body.serviceId) ? await priceOf(request.tx, body.serviceId) : null;
      if (!service) throw new HttpError(404, 'service_not_found', 'No such service');
      if (service.archived) {
        throw new HttpError(409, 'service_archived', 'This service is no longer offered');
      }
      if (service.amountMinor === null) {
        throw new HttpError(409, 'no_price', 'This service has no price in effect');
      }
      const id = randomUUID();
      const posted = await postCharge(request.tx, {
        encounterId: encounter.id,
        patientId: encounter.patient_id,
        serviceId: body.serviceId.toLowerCase(),
        source: 'service',
        sourceRef: `manual:${id}`,
        description: '',
        quantity: body.quantity,
        unitPriceMinor: 0,
        flag: null,
        actorId: userIdOf(request),
      });
      if (!posted) throw new HttpError(404, 'service_not_found', 'No such service');
      request.idempotentId = posted;
      request.audit('create', 'charge', posted);
      return answer(posted);
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
        querystring: InvoiceListQuery,
        response: { 200: ref(InvoicePage), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      const { encounterId } = request.params as { encounterId: string };
      const query = request.query as { cursor?: string; limit?: number };
      if (!(await findEncounter(request.txClient, encounterId))) throw encounterNotFound();
      const page = await listInvoices(request.txClient, {
        encounterId,
        ...query,
        limit: query.limit ?? 25,
      });
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
    '/invoices/search',
    {
      config: { permissions: ['invoice:read'], feature: FEATURE },
      schema: {
        operationId: 'searchInvoices',
        tags: ['billing'],
        description:
          'Invoices of the hospital, newest first, drafts included; the invoice list. The term (number, patient name or MRN), the status and a range of creation dates travel in the body, never in a query string, because a term can name a patient. It reads data only; `total` is given on the first page. Requires invoice:read with the scope `all` and the billing feature flag. Audited as one search.',
        body: ref(InvoiceSearch),
        response: { 200: ref(InvoicePage), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      const body = request.body as Static<typeof InvoiceSearch>;
      const page = await searchInvoices(request.txClient, { ...body, limit: body.limit ?? 25 });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
      request.audit('search', 'invoice');
      return {
        items: page.rows.map(invoiceView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/invoices/:invoiceId/print',
    {
      config: {
        permissions: ['invoice:read', 'invoice:print'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'printInvoice',
        tags: ['billing'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that an invoice is printed (audit action `print`, entity `invoice`) and nothing else: the web app makes the page from what it has read and opens the print dialog once this answers. A draft or a void invoice is not printed (409 `not_printable`). The Idempotency-Key header is required, one per press: a repeat records nothing more. Requires invoice:read, invoice:print with the scope `all` and the billing feature flag.',
        params: InvoiceParams,
        response: {
          204: Type.Null({ description: 'Recorded' }),
          ...errors(401, 403, 404, 409, 429),
        },
      },
    },
    async (request, reply) => {
      requireAll(request, 'invoice:read', 'invoice:print');
      const { invoiceId } = request.params as { invoiceId: string };
      const row = await findInvoice(request.txClient, invoiceId);
      if (!row) throw invoiceNotFound();
      if (row.status === 'draft' || row.status === 'void') {
        throw new HttpError(409, 'not_printable', 'Only an issued invoice is printed');
      }
      if (request.replayOf === null) request.audit('print', 'invoice', row.id);
      return reply.status(204).send(null);
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
      if (locked.discount_status === 'pending') {
        throw new HttpError(409, 'discount_needs_approval', 'The discount waits for approval');
      }
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
  await app.register(taxRoutes);
  await app.register(packageRoutes);
  await app.register(discountRoutes);
};
