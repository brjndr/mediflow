import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { discardDrafts, findCharge, isUuid, lockInvoice } from './repository.js';
import { Charge, ChargeVoid, Invoice, InvoiceDiscard } from './schemas.js';
import {
  chargeView,
  FEATURE,
  invoiceAnswer,
  invoiceNotFound,
  requireAll,
  userIdOf,
} from './views.js';

const chargeNotFound = () => new HttpError(404, 'charge_not_found', 'No such charge');

/**
 * Taking back what should not be billed (#1240): a pending charge on no draft is voided, and a
 * draft invoice is discarded. Both lock what they change, so a draft made or an invoice issued at
 * the same moment comes wholly before or after.
 */
export const voidRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/charges/:chargeId/void',
    {
      config: {
        permissions: ['charge:void', 'charge:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'voidCharge',
        tags: ['billing'],
        description:
          'Voids a pending charge that is on no draft (#1240), with a reason from a fixed list. It stays in the ledger, void, with who voided it, when and why, and is never billed; the event that posted it does not post it again. A charge that is invoiced or already void is 409 `charge_not_pending`; one on a draft is 409 `charge_on_draft`. A package charge that covers other charges is voided only with `confirmCovered: true` (409 `covers_charges` otherwise); the covered charges stay void. Emits `charge.voided`. The Idempotency-Key header is required: a repeat voids nothing more and answers with the charge as it is now. Requires charge:void and charge:read with the scope `all` and the billing feature flag. Audited.',
        params: Type.Object({ chargeId: Type.String({ maxLength: 64 }) }),
        headers: RequiredIdempotencyHeaders,
        body: ref(ChargeVoid),
        response: { 200: ref(Charge), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'charge:void', 'charge:read');
      const client = request.txClient;
      const answer = async (id: string) => {
        const row = await findCharge(client, id);
        if (!row) throw chargeNotFound();
        return chargeView(row);
      };
      if (request.replayOf !== null) {
        if (!request.idempotentId) throw chargeNotFound();
        return answer(request.idempotentId);
      }
      const { chargeId } = request.params as { chargeId: string };
      const body = request.body as ChargeVoid;
      if (!isUuid(chargeId)) throw chargeNotFound();
      // A charge never changes its source or visit, so they are read before anything is held.
      const { rows: found } = await client.query<{ source: string; encounter_id: string }>(
        'select source, encounter_id from charges where id = $1',
        [chargeId],
      );
      if (!found[0]) throw chargeNotFound();
      if (found[0].source === 'package') {
        // As when a package is applied: work posted at the same moment reads the visit `for
        // share`, so it is either counted as covered here or sees the package void.
        await client.query('select 1 from encounters where id = $1 for update', [
          found[0].encounter_id,
        ]);
      }
      const { rows } = await client.query<{
        id: string;
        patient_id: string;
        encounter_id: string;
        status: string;
        invoice_id: string | null;
      }>(
        `select id, patient_id, encounter_id, status, invoice_id from charges
          where id = $1 for update`,
        [chargeId],
      );
      const charge = rows[0];
      if (!charge) throw chargeNotFound();
      if (charge.status !== 'pending') {
        throw new HttpError(409, 'charge_not_pending', 'Only a pending charge is voided');
      }
      if (charge.invoice_id !== null) {
        throw new HttpError(409, 'charge_on_draft', 'Take the charge off its draft first');
      }
      const covered = await client.query(
        'select 1 from charges where package_charge_id = $1 limit 1',
        [charge.id],
      );
      const covers = (covered.rowCount ?? 0) > 0;
      if (covers && body.confirmCovered !== true) {
        throw new HttpError(
          409,
          'covers_charges',
          'The package covers other charges, which stay void: confirm to void it',
        );
      }
      // A charge voided by hand has nothing left to review.
      await client.query(
        `update charges set status = 'void', voided_at = now(), voided_by = $2, void_reason = $3,
           flag = case when flag in ('return_review', 'relink_review') then null else flag end
         where id = $1`,
        [charge.id, userIdOf(request), body.reason],
      );
      request.idempotentId = charge.id;
      request.audit(
        'void',
        'charge',
        charge.id,
        covers ? `${body.reason}, covered charges confirmed` : body.reason,
      );
      await request.emit('charge.voided', charge.id, {
        chargeId: charge.id,
        encounterId: charge.encounter_id,
        patientId: charge.patient_id,
      });
      return answer(charge.id);
    },
  );

  app.post(
    '/invoices/:invoiceId/discard',
    {
      config: {
        permissions: ['invoice:discard', 'invoice:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'discardInvoice',
        tags: ['billing'],
        description:
          'Discards a draft invoice (#1240), with a reason from a fixed list and the version the person saw (409 `version_conflict`). It becomes `void` with no number, with who discarded it, when and why; its lines are kept as history and its charges go back to pending. Only a draft is discarded (409 `invoice_not_draft`). Discarding one invoice of a split pair discards both drafts together: refused when the other is already issued (409 `split_issued`) or a claim to the payer stands on the visit (409 `claim_depends`); a pair whose other invoice was voided by a credit note discards the draft left. Emits `invoice.discarded` for each. The Idempotency-Key header is required: a repeat discards nothing more and answers with the invoice as it is now. Requires invoice:discard and invoice:read with the scope `all` and the billing feature flag. Audited.',
        params: Type.Object({ invoiceId: Type.String({ maxLength: 64 }) }),
        headers: RequiredIdempotencyHeaders,
        body: ref(InvoiceDiscard),
        response: { 200: ref(Invoice), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'invoice:discard', 'invoice:read');
      const client = request.txClient;
      if (request.replayOf !== null) {
        if (!request.idempotentId) throw invoiceNotFound();
        return invoiceAnswer(request, request.idempotentId);
      }
      const { invoiceId } = request.params as { invoiceId: string };
      const body = request.body as InvoiceDiscard;
      if (!isUuid(invoiceId)) throw invoiceNotFound();
      // An invoice keeps its visit and its split, so they are read before anything is held.
      const { rows: found } = await client.query<{
        encounter_id: string;
        split_group: string | null;
        status: string;
      }>('select encounter_id, split_group, status from invoices where id = $1', [invoiceId]);
      const probe = found[0];
      if (!probe) throw invoiceNotFound();
      // Nothing goes back to draft, so an invoice past it is refused before anything is held.
      if (probe.status !== 'draft') {
        throw new HttpError(409, 'invoice_not_draft', 'Only a draft is discarded');
      }
      if (probe.split_group !== null) {
        // A claim is made holding the visit `for share`: it is seen below or made afterwards.
        await client.query('select 1 from encounters where id = $1 for update', [
          probe.encounter_id,
        ]);
        // Both drafts are held in one order. An issued sibling is not held: a credit note on it
        // takes its row and then the draft's.
        await client.query(
          `select 1 from invoices where split_group = $1 and status = 'draft'
            order by id for update`,
          [probe.split_group],
        );
      }
      const locked = await lockInvoice(client, invoiceId);
      if (!locked) throw invoiceNotFound();
      if (locked.status !== 'draft') {
        throw new HttpError(409, 'invoice_not_draft', 'Only a draft is discarded');
      }
      if (locked.version !== body.version) {
        throw new HttpError(409, 'version_conflict', 'The invoice was changed by someone else');
      }
      let ids = [locked.id];
      if (locked.split_group !== null) {
        const { rows: pair } = await client.query<{
          id: string;
          status: string;
          payer_id: string | null;
        }>('select id, status, payer_id from invoices where split_group = $1 order by id', [
          locked.split_group,
        ]);
        if (pair.some((half) => half.status === 'issued' || half.status === 'paid')) {
          throw new HttpError(
            409,
            'split_issued',
            'The other invoice of this split pair is issued: void it with a credit note first',
          );
        }
        const payerId = pair.find((half) => half.payer_id !== null)?.payer_id;
        if (
          payerId &&
          (await app.splitHolds.standing(client, { encounterId: locked.encounter_id, payerId }))
        ) {
          throw new HttpError(409, 'claim_depends', 'A claim to the payer depends on this split');
        }
        ids = pair.filter((half) => half.status === 'draft').map((half) => half.id);
      }
      await discardDrafts(client, ids, userIdOf(request), body.reason);
      request.idempotentId = locked.id;
      for (const id of ids) {
        request.audit('discard', 'invoice', id, body.reason);
        await request.emit('invoice.discarded', id, {
          invoiceId: id,
          encounterId: locked.encounter_id,
          patientId: locked.patient_id,
        });
      }
      return invoiceAnswer(request, locked.id);
    },
  );
};
