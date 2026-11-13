import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockChargeService, mockCharges } from './billing';
import { mockEncounter } from './clinical';
import { mockActivePolicy } from './coverage';
import { mockAgreementOn, mockPlanTerms } from './insurance';

type Split = components['schemas']['CoverageSplit'];
type Line = components['schemas']['CoverageSplitLine'];
type Saved = NonNullable<Split['saved']>;

const FEATURE_FLAG = 'insurance';

/** The copies kept by "Save the split", by hospital and visit. */
let saved = new Map<string, Saved>();
onMockReset(() => {
  saved = new Map();
});

/** `numerator / denominator` rounded half up, on integers only. */
const halfUp = (numerator: number, denominator: number) =>
  Math.floor((numerator * 2 + denominator) / (denominator * 2));

/**
 * Divides a visit's charge ledger between the patient and the payer, as the API will: each
 * charge at the payer's agreed rate, then the plan's covered services, the limit per service,
 * the patient's co-pay share and the sum insured, in that order. Whole minor units only, so for
 * every line payer + patient = rated and the totals reconcile with the ledger.
 */
function work(tenantId: string, encounterId: string): Split | undefined {
  const visit = mockEncounter(encounterId);
  if (!visit || visit.tenantId !== tenantId) return undefined;
  const policy = mockActivePolicy(tenantId, visit.patientId);
  const plan = policy && mockPlanTerms(tenantId, policy.planId);
  if (!policy || !plan) return undefined;
  const agreement = mockAgreementOn(
    tenantId,
    policy.payerId,
    new Date().toISOString().slice(0, 10),
  );
  const listed = new Map(plan.services.map((one) => [one.serviceId, one.limitMinor]));

  let payerTotal = 0;
  const paidByService = new Map<string, number>();
  const lines: Line[] = [];
  for (const charge of mockCharges()) {
    if (charge.tenantId !== tenantId || charge.encounterId !== encounterId) continue;
    if (charge.status === 'void') continue;
    const serviceId = mockChargeService(charge.id);
    const agreed = agreement?.rates.find((one) => one.serviceId === serviceId);
    const rated = agreed
      ? agreed.rateMinor * charge.quantity
      : charge.totalMinor - halfUp(charge.totalMinor * (agreement?.discountBp ?? 0), 10000);

    const isListed = serviceId !== undefined && listed.has(serviceId);
    const covered = plan.coverageMode === 'all_except' ? !isListed : isListed;
    let reason: Line['reason'] = 'covered';
    let payer = 0;
    if (!covered) {
      reason = 'not_covered';
    } else {
      let eligible = rated;
      const limit = serviceId === undefined ? undefined : listed.get(serviceId);
      if (serviceId !== undefined && limit !== undefined) {
        eligible = Math.min(rated, Math.max(limit - (paidByService.get(serviceId) ?? 0), 0));
        if (eligible < rated) reason = 'service_limit';
      }
      const copay = halfUp(eligible * plan.copayPercent, 100);
      payer = eligible - copay;
      if (copay > 0 && reason === 'covered') reason = 'copay';
      if (plan.sumInsuredMinor !== undefined) {
        const room = Math.max(plan.sumInsuredMinor - payerTotal, 0);
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
      ledgerMinor: charge.totalMinor,
      ratedMinor: rated,
      payerMinor: payer,
      patientMinor: rated - payer,
      reason,
    });
  }
  const sum = (pick: (line: Line) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  const ledgerMinor = sum((line) => line.ledgerMinor);
  const ratedMinor = sum((line) => line.ratedMinor);
  const copy = saved.get(`${tenantId}:${encounterId}`);
  return {
    encounterId,
    policyId: policy.id,
    payerName: policy.payerName,
    planName: policy.planName,
    ...(agreement ? { agreementName: agreement.name } : {}),
    copayPercent: plan.copayPercent,
    lines,
    ledgerMinor,
    rateAdjustmentMinor: ratedMinor - ledgerMinor,
    payerMinor: sum((line) => line.payerMinor),
    patientMinor: sum((line) => line.patientMinor),
    ...(copy ? { saved: copy } : {}),
    stale: copy !== undefined && copy.ledgerMinor !== ledgerMinor,
  };
}

export const coverageSplitHandlers = [
  http.get('*/api/encounters/:encounterId/coverage-split', ({ request, params }) => {
    const access = authorize(request, { permission: 'policy:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const denied = authorize(request, { permission: 'charge:read' });
    if ('denied' in denied) return denied.denied;
    const split = work(access.tenantId, String(params.encounterId));
    if (!split) return error(404, 'not_found', 'No active policy for this visit');
    return HttpResponse.json(split);
  }),

  http.post('*/api/encounters/:encounterId/coverage-split', ({ request, params }) => {
    const access = authorize(request, { permission: 'policy:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const denied = authorize(request, { permission: 'charge:read' });
    if ('denied' in denied) return denied.denied;
    if (!request.headers.get('Idempotency-Key')) {
      return error(400, 'validation_failed', 'Idempotency-Key is required');
    }
    const encounterId = String(params.encounterId);
    const split = work(access.tenantId, encounterId);
    if (!split) return error(404, 'not_found', 'No active policy for this visit');
    saved.set(`${access.tenantId}:${encounterId}`, {
      savedAt: new Date().toISOString(),
      ledgerMinor: split.ledgerMinor,
      payerMinor: split.payerMinor,
      patientMinor: split.patientMinor,
    });
    return HttpResponse.json(work(access.tenantId, encounterId));
  }),
];
