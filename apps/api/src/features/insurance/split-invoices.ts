import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { EncounterParams } from './schemas.js';
import { computeSplit, visitPatient } from './split.js';
import { isCode, requirePatient, userIdOf } from './util.js';

const FEATURE = 'insurance';

export const SplitInvoices = Type.Object(
  {
    splitGroup: Type.String(),
    payerInvoiceId: Type.String({ description: "The payer's share, billed to the payer." }),
    patientInvoiceId: Type.Optional(
      Type.String({ description: "The patient's share; none when the patient owes nothing." }),
    ),
    payerMinor: Type.Integer({ minimum: 1 }),
    patientMinor: Type.Integer({ minimum: 0 }),
  },
  { $id: 'SplitInvoices', additionalProperties: false },
);
export type SplitInvoices = Static<typeof SplitInvoices>;
export const SPLIT_INVOICE_SCHEMAS = [SplitInvoices];

const lineSource = (source: string | undefined) =>
  source === undefined || source === 'manual' ? 'service' : source;

const label = (description: string, suffix: string) =>
  `${description.slice(0, 200 - suffix.length - 1)} ${suffix}`;

interface Share {
  chargeId: string;
  source: string;
  description: string;
  minor: number;
}

/** A draft invoice of the visit with a line for each share, priced as the split worked it out. */
async function insertDraft(
  client: pg.ClientBase,
  invoice: {
    id: string;
    encounterId: string;
    patientId: string;
    group: string;
    payerId: string | null;
    by: string;
  },
  shares: Share[],
): Promise<void> {
  const total = shares.reduce((sum, share) => sum + share.minor, 0);
  await client.query(
    `insert into invoices (id, tenant_id, encounter_id, patient_id, currency, created_by,
       split_group, payer_id)
     select $1, t.id, $2, $3, t.currency, $4, $5, $6 from tenants t where t.id = app_tenant_id()`,
    [
      invoice.id,
      invoice.encounterId,
      invoice.patientId,
      invoice.by,
      invoice.group,
      invoice.payerId,
    ],
  );
  for (const [index, share] of shares.entries()) {
    await client.query(
      `insert into invoice_lines (tenant_id, invoice_id, line_number, charge_id, source,
         description, quantity, unit_price_minor)
       values (app_tenant_id(), $1, $2, $3, $4, $5, 1, $6)`,
      [invoice.id, index + 1, share.chargeId, share.source, share.description, share.minor],
    );
  }
  await client.query('update invoices set total_minor = $2 where id = $1', [invoice.id, total]);
}

async function answerOf(client: pg.ClientBase, payerInvoiceId: string): Promise<SplitInvoices> {
  const { rows } = await client.query<{
    split_group: string;
    id: string;
    payer_minor: string;
    patient_id: string | null;
    patient_minor: string | null;
  }>(
    `select p.split_group, p.id, p.total_minor::text as payer_minor,
            m.id as patient_id, m.total_minor::text as patient_minor
       from invoices p
       left join invoices m on m.tenant_id = p.tenant_id and m.split_group = p.split_group
         and m.payer_id is null
      where p.id = $1 and p.payer_id is not null`,
    [payerInvoiceId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'invoice_not_found', 'No such invoice');
  return {
    splitGroup: row.split_group,
    payerInvoiceId: row.id,
    ...(row.patient_id ? { patientInvoiceId: row.patient_id } : {}),
    payerMinor: Number(row.payer_minor),
    patientMinor: Number(row.patient_minor ?? 0),
  };
}

export const splitInvoiceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/encounters/:encounterId/split-invoices',
    {
      config: {
        permissions: ['invoice:create', 'invoice:read', 'charge:read', 'policy:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createSplitInvoices',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          "Bills an insured visit as two drafts (#977): the payer's share to the payer of the patient's active policy and the patient's share, each line priced as the coverage split works it out now (never a client figure), with a line for each charge that has a share. The charges of the visit go to the patient's invoice (to the payer's when the patient owes nothing), so each is billed once, and neither draft is edited (409 `split_invoice_locked`): they are issued, paid and credited as they are. Every charge of the visit must be pending and free (409 `charges_not_pending`); the payer owing nothing is 422 `nothing_to_bill`; no active policy is 404 `no_active_policy`; a visit with a live payer invoice is 409 `split_exists` until that is void; a hospital without billing is 403 `feature_disabled`. The Idempotency-Key header is required: a repeat bills nothing more. Needs invoice:create, invoice:read, charge:read and policy:read with the scope `all`, and the insurance and billing feature flags. Audited.",
        params: EncounterParams,
        response: { 201: ref(SplitInvoices), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const policy = await request.access.policy();
      if (policy?.features.billing !== true) {
        throw new HttpError(403, 'feature_disabled', 'Billing is not switched on');
      }
      for (const permission of ['invoice:create', 'invoice:read', 'charge:read'] as const) {
        if (request.access.scope(permission) !== 'all') {
          throw new HttpError(403, 'permission_denied', 'Billing needs the scope all');
        }
      }
      const client = request.txClient;
      if (request.replayOf !== null) {
        if (!request.idempotentId) throw new HttpError(404, 'invoice_not_found', 'No such invoice');
        return reply.status(201).send(await answerOf(client, request.idempotentId));
      }
      const encounterId = request.params.encounterId;
      const patientId = await visitPatient(client, encounterId);
      await requirePatient(request, patientId);
      const status = (
        await client.query<{ status: string }>('select status from encounters where id = $1', [
          encounterId,
        ])
      ).rows[0]?.status;
      if (status === 'cancelled') {
        throw new HttpError(409, 'encounter_cancelled', 'A cancelled visit has nothing to bill');
      }
      // The ledger is held while it is divided, so no draft takes a charge in between.
      const held = await client.query<{ id: string; source: string; ok: boolean }>(
        `select id, source, (status = 'pending' and invoice_id is null) as ok from charges
          where encounter_id = $1 and status <> 'void' order by id for update`,
        [encounterId],
      );
      if (held.rows.some((row) => !row.ok)) {
        throw new HttpError(
          409,
          'charges_not_pending',
          'Every charge of the visit must be waiting to be billed',
        );
      }
      const visit = await computeSplit(client, encounterId, patientId);
      if (visit.split.payerMinor <= 0) {
        throw new HttpError(422, 'nothing_to_bill', 'The payer owes nothing');
      }
      const sources = new Map(held.rows.map((row) => [row.id, row.source]));
      const share = (pick: 'payerMinor' | 'patientMinor', suffix: string): Share[] =>
        visit.split.lines
          .filter((line) => line[pick] > 0)
          .map((line) => ({
            chargeId: line.chargeId,
            // A line of a charge is never source 'manual' (that is a typed line).
            source: lineSource(sources.get(line.chargeId)),
            description: label(line.description, suffix),
            minor: line[pick],
          }));
      const payerShares = share('payerMinor', '(payer share)');
      const patientShares = share('patientMinor', '(patient share)');
      const group = randomUUID();
      const by = userIdOf(request);
      const payerInvoiceId = randomUUID();
      const patientInvoiceId = patientShares.length > 0 ? randomUUID() : undefined;
      const base = { encounterId, patientId, group, by };
      try {
        if (patientInvoiceId) {
          await insertDraft(
            client,
            { ...base, id: patientInvoiceId, payerId: null },
            patientShares,
          );
        }
        await insertDraft(
          client,
          { ...base, id: payerInvoiceId, payerId: visit.payerId },
          payerShares,
        );
      } catch (error) {
        if (isCode(error, '23505', 'invoices_one_payer_share')) {
          throw new HttpError(
            409,
            'split_exists',
            'This visit already has an invoice to the payer',
          );
        }
        throw error;
      }
      await client.query(`update charges set invoice_id = $2 where id = any($1::uuid[])`, [
        held.rows.map((row) => row.id),
        patientInvoiceId ?? payerInvoiceId,
      ]);
      request.idempotentId = payerInvoiceId;
      request.audit('create', 'invoice', payerInvoiceId);
      if (patientInvoiceId) request.audit('create', 'invoice', patientInvoiceId);
      return reply.status(201).send(await answerOf(client, payerInvoiceId));
    },
  );
};
