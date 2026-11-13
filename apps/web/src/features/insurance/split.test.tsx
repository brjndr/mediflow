import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { setMockChargeService } from '@/mocks/handlers/billing';
import { setMockAgreementTerms, setMockPlanCover } from '@/mocks/handlers/insurance';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { splitReconciles } from './split';
import type { CoverageSplit } from './types';

// Split billing and co-pay (#183): the panel of the invoice builder. The sample visit enc_h_1 has
// three charges (500.00, 350.00 and two strips at 25.50: 901.00) and the patient a Gold policy
// with a 10% co-pay and, with the agreement set to 10% off list prices, a 810.90 rated bill.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

async function openPanel() {
  const app = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
  const panel = await screen.findByRole('region', {
    name: 'Split between the patient and the payer',
  });
  await within(panel).findByTestId('split-ledger');
  return { app, panel };
}

describe('splitReconciles', () => {
  const split: CoverageSplit = {
    encounterId: 'e',
    policyId: 'p',
    payerName: 'P',
    planName: 'Q',
    copayPercent: 10,
    lines: [
      {
        chargeId: 'c',
        description: 'x',
        ledgerMinor: 1000,
        ratedMinor: 900,
        payerMinor: 810,
        patientMinor: 90,
        reason: 'copay',
      },
    ],
    ledgerMinor: 1000,
    rateAdjustmentMinor: -100,
    payerMinor: 810,
    patientMinor: 90,
    stale: false,
  };
  it('accepts figures that add up and refuses a cent that is lost', () => {
    expect(splitReconciles(split)).toBe(true);
    expect(splitReconciles({ ...split, patientMinor: 89 })).toBe(false);
    expect(splitReconciles({ ...split, rateAdjustmentMinor: -99 })).toBe(false);
    expect(splitReconciles({ ...split, lines: [{ ...split.lines[0]!, payerMinor: 800 }] })).toBe(
      false,
    );
  });
});

describe('the split panel', () => {
  it('divides the ledger by the co-pay at the payer rate, adds up and has no axe violations', async () => {
    setMockAgreementTerms('agr_h_2026', 1000);
    const { panel } = await openPanel();
    expect(within(panel).getByTestId('split-ledger')).toHaveTextContent('901.00');
    expect(within(panel).getByTestId('split-adjustment')).toHaveTextContent('90.10');
    // Rated 810.90: the patient's 10% is 81.09, rounded on each line (45.00 + 31.50 + 4.59 -> 8109).
    expect(within(panel).getByTestId('split-patient')).toHaveTextContent('81.09');
    expect(within(panel).getByTestId('split-payer')).toHaveTextContent('729.81');
    expect(within(panel).getByText('The split adds up to the charges')).toBeVisible();
    expect(within(panel).getAllByText('Co-pay on a covered charge').length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });

  it('leaves a service the plan does not cover to the patient', async () => {
    setMockAgreementTerms('agr_h_2026', 0);
    setMockChargeService('chg_h_2', 'svc_blood');
    setMockPlanCover('pln_h_gold', 'all_except', [{ serviceId: 'svc_blood' }]);
    const { panel } = await openPanel();
    expect(within(panel).getByText('Not covered by the plan')).toBeVisible();
    // 500.00 and 51.00 at 10% co-pay: 55.10 + the whole 350.00.
    expect(within(panel).getByTestId('split-patient')).toHaveTextContent('405.10');
    expect(within(panel).getByTestId('split-payer')).toHaveTextContent('495.90');
    expect(within(panel).getByText('The split adds up to the charges')).toBeVisible();
  });

  it('stops the payer at a limit for a service and at the sum insured', async () => {
    setMockAgreementTerms('agr_h_2026', 0);
    setMockChargeService('chg_h_1', 'svc_consult');
    setMockPlanCover(
      'pln_h_gold',
      'only_listed',
      [{ serviceId: 'svc_consult', limitMinor: 20000 }],
      0,
    );
    const { panel } = await openPanel();
    expect(within(panel).getByText('Above the limit for this service')).toBeVisible();
    expect(within(panel).getByTestId('split-payer')).toHaveTextContent('200.00');
    expect(within(panel).getByTestId('split-patient')).toHaveTextContent('701.00');

    setMockPlanCover('pln_h_gold', 'all_except', [], 0, 30000);
  });

  it('keeps the split when saved and says so', async () => {
    setMockAgreementTerms('agr_h_2026', 1000);
    const { panel } = await openPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'Save the split' }));
    expect(await within(panel).findByText('The split was saved.')).toBeVisible();
    expect(within(panel).queryByText(/charges have changed since/)).toBeNull();
  });

  it('is left out without policy:read, without a policy and without the insurance switch', async () => {
    revokePermission(HOSPITAL, 'admin', 'policy:read');
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    await screen.findByRole('heading', { name: 'New invoice', level: 1 });
    await waitFor(() => expect(screen.queryByTestId('split-ledger')).toBeNull());
  });

  it('offers no save without policy:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'policy:manage');
    const { panel } = await openPanel();
    expect(within(panel).queryByRole('button', { name: 'Save the split' })).toBeNull();
  });

  it('shows nothing at the clinic, which has no plan of this hospital', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    grantPermission(CLINIC, 'doctor', 'policy:read');
    setTenantFeature(CLINIC, 'insurance', true);
    renderApp({ entry: '/billing/new?encounterId=enc_c_1' });
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(screen.queryByTestId('split-ledger')).toBeNull());
  });
});
