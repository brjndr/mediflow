import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { todayAtHospital } from '../../core/tenancy/today.js';
import {
  CoverageSplit,
  SplitSaveHeaders,
  type CoverageSplit as CoverageSplitBody,
  type CoverageSplitLine,
} from './claim-schemas.js';
import { EncounterParams } from './schemas.js';
import { isUuid, requirePatient, userIdOf } from './util.js';

const FEATURE = 'insurance';

/** `numerator / denominator` rounded half up, on integers only. */
const halfUp = (numerator: number, denominator: number) =>
  Math.floor((numerator * 2 + denominator) / (denominator * 2));

export interface VisitSplit {
  patientId: string;
  payerId: string;
  policyNumber: string;
  split: CoverageSplitBody;
}

/** The visit's patient, or 404 `encounter_not_found`. */
export async function visitPatient(client: pg.ClientBase, encounterId: string): Promise<string> {
  const found = isUuid(encounterId)
    ? (
        await client.query<{ patient_id: string }>(
          'select patient_id from encounters where id = $1',
          [encounterId],
        )
      ).rows[0]
    : undefined;
  if (!found) throw new HttpError(404, 'encounter_not_found', 'No such visit');
  return found.patient_id;
}

interface PolicyTerms {
  id: string;
  payer_id: string;
  payer_name: string;
  plan_name: string;
  policy_number: string;
  plan_id: string;
  coverage_mode: 'all_except' | 'only_listed';
  copay_percent: number;
  sum_insured_minor: string | null;
}

/**
 * Divides a visit's charge ledger between the patient and the payer of the patient's newest
 * active policy, in this order for every charge: the payer's agreed rate, whether the plan covers
 * the service, the limit per service, the patient's co-pay share, and the sum insured. Whole minor
 * units only, so for every line payer + patient = rated and the totals reconcile with the ledger.
 * 404 `no_active_policy` when there is no policy to bill.
 */
export async function computeSplit(
  client: pg.ClientBase,
  encounterId: string,
  patientId: string,
): Promise<VisitSplit> {
  const today = await todayAtHospital(client);
  const policy = (
    await client.query<PolicyTerms>(
      `select x.id, x.payer_id, py.name as payer_name, pl.name as plan_name, x.policy_number,
              x.plan_id, pl.coverage_mode, pl.copay_percent, pl.sum_insured_minor
         from patient_policies x
         join payers py on py.tenant_id = x.tenant_id and py.id = x.payer_id
         join payer_plans pl on pl.tenant_id = x.tenant_id and pl.id = x.plan_id
        where x.patient_id = $1 and x.ended_at is null
          and (x.valid_to is null or x.valid_to >= $2::date)
        order by x.created_at desc, x.id desc limit 1`,
      [patientId, today],
    )
  ).rows[0];
  if (!policy) throw new HttpError(404, 'no_active_policy', 'The patient has no active policy');

  const listed = new Map<string, number | null>();
  for (const row of (
    await client.query<{ service_id: string; limit_minor: string | null }>(
      'select service_id, limit_minor from payer_plan_services where plan_id = $1',
      [policy.plan_id],
    )
  ).rows) {
    listed.set(row.service_id, row.limit_minor === null ? null : Number(row.limit_minor));
  }

  const agreement = (
    await client.query<{ id: string; name: string; discount_bp: number }>(
      `select id, name, discount_bp from rate_agreements
        where payer_id = $1 and daterange(effective_from, effective_to, '[]') @> $2::date`,
      [policy.payer_id, today],
    )
  ).rows[0];
  const rates = new Map<string, number>();
  if (agreement) {
    for (const row of (
      await client.query<{ service_id: string; rate_minor: string }>(
        'select service_id, rate_minor from rate_agreement_rates where agreement_id = $1',
        [agreement.id],
      )
    ).rows) {
      rates.set(row.service_id, Number(row.rate_minor));
    }
  }

  const charges = (
    await client.query<{
      id: string;
      description: string;
      service_id: string | null;
      quantity: number;
      total_minor: string;
    }>(
      `select id, description, service_id, quantity, total_minor from charges
        where encounter_id = $1 and status <> 'void' order by posted_at, id`,
      [encounterId],
    )
  ).rows;

  const copayPercent = policy.copay_percent;
  const sumInsured =
    policy.sum_insured_minor === null ? undefined : Number(policy.sum_insured_minor);
  let payerTotal = 0;
  const paidByService = new Map<string, number>();
  const lines: CoverageSplitLine[] = [];
  for (const charge of charges) {
    const total = Number(charge.total_minor);
    const serviceId = charge.service_id ?? undefined;
    const agreed = serviceId === undefined ? undefined : rates.get(serviceId);
    const rated =
      agreed !== undefined
        ? agreed * charge.quantity
        : total - halfUp(total * (agreement?.discount_bp ?? 0), 10000);

    const isListed = serviceId !== undefined && listed.has(serviceId);
    const covered = policy.coverage_mode === 'all_except' ? !isListed : isListed;
    let reason: CoverageSplitLine['reason'] = 'covered';
    let payer = 0;
    if (!covered) {
      reason = 'not_covered';
    } else {
      let eligible = rated;
      const limit = serviceId === undefined ? undefined : listed.get(serviceId);
      if (serviceId !== undefined && limit !== undefined && limit !== null) {
        eligible = Math.min(rated, Math.max(limit - (paidByService.get(serviceId) ?? 0), 0));
        if (eligible < rated) reason = 'service_limit';
      }
      const copay = halfUp(eligible * copayPercent, 100);
      payer = eligible - copay;
      if (copay > 0 && reason === 'covered') reason = 'copay';
      if (sumInsured !== undefined) {
        const room = Math.max(sumInsured - payerTotal, 0);
        if (payer > room) {
          payer = room;
          reason = 'sum_insured';
        }
      }
    }
    payerTotal += payer;
    if (serviceId !== undefined) {
      paidByService.set(serviceId, (paidByService.get(serviceId) ?? 0) + payer);
    }
    lines.push({
      chargeId: charge.id,
      description: charge.description,
      ledgerMinor: total,
      ratedMinor: rated,
      payerMinor: payer,
      patientMinor: rated - payer,
      reason,
    });
  }
  const sum = (pick: (line: CoverageSplitLine) => number) =>
    lines.reduce((acc, line) => acc + pick(line), 0);
  const ledgerMinor = sum((line) => line.ledgerMinor);
  const ratedMinor = sum((line) => line.ratedMinor);

  const copy = (
    await client.query<{
      saved_at: Date;
      ledger_minor: string;
      payer_minor: string;
      patient_minor: string;
    }>(
      'select saved_at, ledger_minor, payer_minor, patient_minor from coverage_splits where encounter_id = $1',
      [encounterId],
    )
  ).rows[0];

  const split: CoverageSplitBody = {
    encounterId,
    policyId: policy.id,
    payerName: policy.payer_name,
    planName: policy.plan_name,
    ...(agreement ? { agreementName: agreement.name } : {}),
    copayPercent,
    lines,
    ledgerMinor,
    rateAdjustmentMinor: ratedMinor - ledgerMinor,
    payerMinor: sum((line) => line.payerMinor),
    patientMinor: sum((line) => line.patientMinor),
    ...(copy
      ? {
          saved: {
            savedAt: copy.saved_at.toISOString(),
            ledgerMinor: Number(copy.ledger_minor),
            payerMinor: Number(copy.payer_minor),
            patientMinor: Number(copy.patient_minor),
          },
        }
      : {}),
    stale: copy !== undefined && Number(copy.ledger_minor) !== ledgerMinor,
  };
  return { patientId, payerId: policy.payer_id, policyNumber: policy.policy_number, split };
}

export const splitRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/encounters/:encounterId/coverage-split',
    {
      config: { permissions: ['policy:read', 'charge:read'], feature: FEATURE },
      schema: {
        operationId: 'getCoverageSplit',
        tags: ['insurance'],
        description:
          "How a visit's charge ledger divides between the patient and the payer of the patient's active policy (IN-03, #183), worked out by the server: each charge at the payer's agreed rate, the plan's covered services, the limit per service, the patient's co-pay share and the sum insured. For every line payerMinor + patientMinor = ratedMinor, and ledgerMinor + rateAdjustmentMinor = payerMinor + patientMinor in total. Needs policy:read, charge:read and the insurance feature flag. 404 when the patient has no active policy. Audited.",
        params: EncounterParams,
        response: { 200: ref(CoverageSplit), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const patientId = await visitPatient(request.txClient, request.params.encounterId);
      await requirePatient(request, patientId);
      const { split } = await computeSplit(request.txClient, request.params.encounterId, patientId);
      request.audit('read', 'coverage_split', request.params.encounterId);
      return split;
    },
  );

  app.post(
    '/encounters/:encounterId/coverage-split',
    {
      config: {
        permissions: ['policy:manage', 'charge:read'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'saveCoverageSplit',
        tags: ['insurance'],
        headers: SplitSaveHeaders,
        description:
          'Keeps the split as it is now, as the one the patient and payer bills are made from. A later change to the ledger makes the saved split stale (stale: true) until it is saved again. Needs policy:manage and charge:read. Idempotent by Idempotency-Key. Audited.',
        params: EncounterParams,
        response: { 200: ref(CoverageSplit), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const encounterId = request.params.encounterId;
      const patientId = await visitPatient(client, encounterId);
      await requirePatient(request, patientId);
      const { split } = await computeSplit(client, encounterId, patientId);
      await client.query(
        `insert into coverage_splits (encounter_id, policy_id, ledger_minor, payer_minor,
           patient_minor, saved_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id, encounter_id) do update set policy_id = excluded.policy_id,
           ledger_minor = excluded.ledger_minor, payer_minor = excluded.payer_minor,
           patient_minor = excluded.patient_minor, saved_by = excluded.saved_by, saved_at = now()`,
        [
          encounterId,
          split.policyId,
          split.ledgerMinor,
          split.payerMinor,
          split.patientMinor,
          userIdOf(request),
        ],
      );
      request.audit('update', 'coverage_split', encounterId);
      return (await computeSplit(client, encounterId, patientId)).split;
    },
  );
};
