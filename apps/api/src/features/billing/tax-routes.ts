import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { TaxRates, TaxRatesUpdate, type TaxRatesUpdate as Update } from './schemas.js';
import { TAX_CLASSES, taxRatesOf } from './tax.js';
import { FEATURE, requireAll, userIdOf } from './views.js';

/**
 * The hospital's tax rate for each tax class (#119). A class with no rate of its own takes the
 * default. Nothing here is about a patient, so a read is not audited; a change is.
 */
export const taxRoutes: FastifyPluginAsyncTypebox = async (app) => {
  async function answer(request: FastifyRequest) {
    const rates = await taxRatesOf(request.txClient);
    return { items: TAX_CLASSES.map((taxClass) => ({ taxClass, rateBp: rates[taxClass] })) };
  }

  app.get(
    '/billing/tax-rates',
    {
      config: { permissions: ['invoice:read'], feature: FEATURE },
      schema: {
        operationId: 'getTaxRates',
        tags: ['billing'],
        description:
          'The tax rate of every tax class at the hospital, in basis points (#119): the hospital’s own where it has set one, else the default (exempt 0, reduced 5%, standard 12%, higher 18%). Requires invoice:read with the scope `all` and the billing feature flag.',
        response: { 200: ref(TaxRates), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:read');
      return answer(request);
    },
  );

  app.put(
    '/billing/tax-rates',
    {
      config: {
        permissions: ['taxRate:manage', 'invoice:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'setTaxRates',
        tags: ['billing'],
        description:
          'Sets the tax rate of the classes named (#119), each once; a class left out keeps its rate. A draft takes the new rates when it is next saved; an issued invoice keeps the rates it was made with. The Idempotency-Key header is required. Requires taxRate:manage and invoice:read with the scope `all` and the billing feature flag. Audited.',
        headers: RequiredIdempotencyHeaders,
        body: ref(TaxRatesUpdate),
        response: { 200: ref(TaxRates), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'taxRate:manage', 'invoice:read');
      if (request.replayOf !== null) return answer(request);
      const body = request.body as Update;
      const classes = body.items.map((item) => item.taxClass);
      if (new Set(classes).size !== classes.length) {
        throw new HttpError(400, 'validation_failed', 'Each tax class is named once');
      }
      const by = userIdOf(request);
      for (const item of body.items) {
        await request.txClient.query(
          `insert into tax_rates (tenant_id, tax_class, rate_bp, updated_by)
           values (app_tenant_id(), $1, $2, $3)
           on conflict (tenant_id, tax_class)
           do update set rate_bp = excluded.rate_bp, updated_by = excluded.updated_by,
             updated_at = now()`,
          [item.taxClass, item.rateBp, by],
        );
      }
      request.audit('update', 'tax_rate');
      return answer(request);
    },
  );
};
