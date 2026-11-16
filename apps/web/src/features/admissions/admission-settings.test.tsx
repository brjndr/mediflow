import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { addMockSignedSummary, setMockSummaryRequired } from '@/mocks/handlers/discharge-summary';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The hospital rule that a discharge waits for a signed discharge summary (#952).

const SWITCH = 'Require a signed discharge summary before discharge';

/** Opens the discharge panel of an admitted stay with the clearances done, and submits. */
async function dischargeStay(id: string) {
  const grid = await screen.findByRole('table', { name: 'Admissions' });
  await userEvent.click(await within(grid).findByRole('button', { name: /Discharge/ }));
  const panel = await screen.findByRole('region', { name: /Discharge / });
  // Against advice and absconded need fewer clearances; absconded none, but is exempt, so use
  // against advice and clear what it needs.
  await userEvent.selectOptions(
    await within(panel).findByRole('combobox', { name: 'How the stay ends' }),
    'against_advice',
  );
  for (const kind of ['Nursing', 'Pharmacy (medicines to return)']) {
    await userEvent.click(within(panel).getByRole('button', { name: `Mark ${kind} cleared` }));
    await within(panel).findByRole('button', { name: `Reopen ${kind}` });
  }
  await userEvent.click(within(panel).getByRole('button', { name: 'Discharge patient' }));
  return id;
}

describe('requiring a signed discharge summary', () => {
  it('is a switch for the hospital admin that saves and is announced', async () => {
    addMockAdmission({ id: 'adm_set', status: 'admitted', version: 1 });
    renderApp({ entry: '/admissions' });
    const toggle = await screen.findByRole('switch', { name: SWITCH });
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    expect(
      await screen.findByText(/A discharge now waits for a signed summary/),
    ).toBeInTheDocument();
    expect(toggle).toBeChecked();
    await expectNoAxeViolations();
  }, 30_000);

  it('is not shown without admission:configure', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'admission:configure');
    addMockAdmission({ id: 'adm_none', status: 'admitted', version: 1 });
    renderApp({ entry: '/admissions' });
    await screen.findByRole('table', { name: 'Admissions' });
    expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull();
  });

  it('discharges as before while the rule is off', async () => {
    addMockAdmission({ id: 'adm_off', status: 'admitted', version: 1 });
    renderApp({ entry: '/admissions' });
    await dischargeStay('adm_off');
    expect(await screen.findByText(/is discharged\. The bed is being cleaned/)).toBeInTheDocument();
  }, 30_000);

  it('refuses without a signed summary, with a link to it, then discharges once signed', async () => {
    setMockSummaryRequired(TENANT_IDS.hospital, true);
    addMockAdmission({ id: 'adm_on', status: 'admitted', version: 1 });
    renderApp({ entry: '/admissions' });
    await dischargeStay('adm_on');

    expect(await screen.findByText(/needs the discharge summary signed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the discharge summary' })).toHaveAttribute(
      'href',
      '/admissions/adm_on/summary',
    );

    addMockSignedSummary(TENANT_IDS.hospital, 'adm_on');
    await userEvent.click(screen.getByRole('button', { name: 'Discharge patient' }));
    expect(await screen.findByText(/is discharged\. The bed is being cleaned/)).toBeInTheDocument();
  }, 30_000);

  it('does not apply to a second hospital', async () => {
    // Required for the clinic only: the hospital under test discharges freely.
    setMockSummaryRequired(TENANT_IDS.clinic, true);
    addMockAdmission({ id: 'adm_other', status: 'admitted', version: 1 });
    renderApp({ entry: '/admissions' });
    await dischargeStay('adm_other');
    expect(await screen.findByText(/is discharged\. The bed is being cleaned/)).toBeInTheDocument();
  }, 30_000);
});
