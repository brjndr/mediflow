import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { discountLimitOf } from './discount.js';
import { approveDiscount, lockInvoice } from './repository.js';
import { DiscountApproval, DiscountSettings, Invoice } from './schemas.js';
import { FEATURE, invoiceAnswer, invoiceNotFound, requireAll, userIdOf } from './views.js';

/**
 * Discount approval and the hospital's limit (#116). A discount above the limit is saved with the
 * draft but waits: someone else with discount:approve approves it, and only then is the invoice
 * issued. Nothing here names a patient or holds free text, so only changes are audited.
 */
export const discountRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/billing/discount-settings',
    {
      config: { permissions: ['invoice:read'], feature: FEATURE },
      schema: {
        operationId: 'getDiscountSettings',
        tags: ['billing'],
        description:
          'The most a bill may be discounted without approval, as a share of the bill before tax in basis points (#116); 500 (5%) until the hospital sets another. Requires invoice:read with the scope `all` and the billing feature flag.',
        response: { 200: ref(DiscountSettings), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      return { limitBp: await discountLimitOf(request.txClient) };
    },
  );

  app.put(
    '/billing/discount-settings',
    {
      config: {
        permissions: ['discount:manage', 'invoice:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'setDiscountSettings',
        tags: ['billing'],
        description:
          'Sets the share of a bill that may be discounted without approval (#116). It applies when a draft is next saved, so a draft already pending stays pending. The Idempotency-Key header is required. Requires discount:manage and invoice:read with the scope `all` and the billing feature flag. Audited.',
        headers: RequiredIdempotencyHeaders,
        body: ref(DiscountSettings),
        response: { 200: ref(DiscountSettings), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'discount:manage', 'invoice:read');
      if (request.replayOf !== null) return { limitBp: await discountLimitOf(request.txClient) };
      const body = request.body as { limitBp: number };
      await request.txClient.query(
        `insert into billing_settings (tenant_id, discount_limit_bp, updated_by)
         values (app_tenant_id(), $1, $2)
         on conflict (tenant_id)
         do update set discount_limit_bp = excluded.discount_limit_bp,
           updated_by = excluded.updated_by, updated_at = now()`,
        [body.limitBp, userIdOf(request)],
      );
      request.audit('update', 'billing_settings');
      return { limitBp: body.limitBp };
    },
  );

  app.post(
    '/invoices/:invoiceId/discount-approval',
    {
      config: {
        permissions: ['discount:approve', 'invoice:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'approveInvoiceDiscount',
        tags: ['billing'],
        description:
          'Approves the discount on a draft that is above the hospital’s limit (#116), for the amount it stands at. Not the person who gave or last changed it (403 `own_discount`); the invoice must be a draft (409 `invoice_not_draft`) whose discount is pending (409 `discount_not_pending`), at the version the approver saw (409 `version_conflict`). Any later change to the discount asks again. The Idempotency-Key header is required: a repeat approves nothing more. Requires discount:approve and invoice:read with the scope `all` and the billing feature flag. Audited.',
        params: { type: 'object', properties: { invoiceId: { type: 'string', maxLength: 64 } } },
        headers: RequiredIdempotencyHeaders,
        body: ref(DiscountApproval),
        response: { 200: ref(Invoice), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'discount:approve', 'invoice:read');
      const { invoiceId } = request.params as { invoiceId: string };
      if (request.replayOf !== null) return invoiceAnswer(request, invoiceId);
      const body = request.body as { version: number };
      const locked = await lockInvoice(request.txClient, invoiceId);
      if (!locked) throw invoiceNotFound();
      if (locked.status !== 'draft') {
        throw new HttpError(409, 'invoice_not_draft', 'An issued invoice is never changed');
      }
      if (locked.version !== body.version) {
        throw new HttpError(409, 'version_conflict', 'The invoice was changed by someone else');
      }
      if (locked.discount_status !== 'pending') {
        throw new HttpError(409, 'discount_not_pending', 'No discount waits for approval');
      }
      const approver = userIdOf(request);
      if (locked.discount_applied_by === approver) {
        throw new HttpError(403, 'own_discount', 'A discount is approved by someone else');
      }
      await approveDiscount(request.txClient, locked.id, approver);
      request.audit('approve', 'invoice', locked.id);
      return invoiceAnswer(request, locked.id);
    },
  );
};
