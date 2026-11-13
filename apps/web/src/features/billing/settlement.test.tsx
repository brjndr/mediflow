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
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { mockCharges, mockInvoices } from '@/mocks/handlers/billing';
import { clearMockStay } from '@/mocks/handlers/discharge-plan';
import { addMockDeposit } from '@/mocks/handlers/stay-bill';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The final bill and settlement of a stay (DS-04, #167) on the hospital's open visit enc_h_1,
// whose ledger holds 500.00 + 350.00 + 51.00 = 901.00.

const HOSPITAL = TENANT_IDS.hospital;

function admit(id = 'adm_final') {
  addMockAdmission({
    id,
    encounterId: 'enc_h_1',
    patientName: 'Asha Verma',
    patientMrn: 'MRN-0042',
  });
  // The ward, pharmacy and laboratory clearances (DS-01) are not what these tests are about.
  clearMockStay(TENANT_IDS.hospital, id);
  return id;
}

/** Makes the final invoice through the builder, as the desk does from the stay's page. */
async function invoiceTheStay() {
  const app = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
  await screen.findByText('INV-0001');
  app.unmount();
}

const figure = (id: string) => screen.findByTestId(id);

describe('the final bill of a stay', () => {
  it('says what is not invoiced, then the invoices add up to the charges', async () => {
    admit();
    const first = renderApp({ entry: '/billing/stays/adm_final' });
    expect((await figure('settle-unbilled')).textContent).toMatch(/901\.00/);
    expect(screen.getByTestId('clearance')).toHaveTextContent('Not ready for discharge');
    expect(screen.getByRole('link', { name: 'Make the final invoice' })).toBeVisible();
    first.unmount();

    await invoiceTheStay();
    renderApp({ entry: '/billing/stays/adm_final' });
    await waitFor(() => expect(screen.getByTestId('settle-unbilled').textContent).toMatch(/0\.00/));
    const ledger = mockCharges()
      .filter((charge) => charge.encounterId === 'enc_h_1' && charge.status !== 'void')
      .reduce((sum, charge) => sum + charge.totalMinor, 0);
    expect(mockInvoices()[0]?.totalMinor).toBe(ledger);
    expect(screen.getByTestId('settle-charges').textContent).toMatch(/901\.00/);
    expect(screen.getByTestId('settle-invoiced').textContent).toMatch(/901\.00/);
    expect(screen.getByTestId('match')).toHaveTextContent('The invoices add up to the charges');
    expect(screen.getByTestId('settle-due').textContent).toMatch(/901\.00/);
    const grid = screen.getByRole('table', { name: 'Invoices of the stay' });
    expect(within(grid).getByText('INV-0001')).toBeVisible();
    await expectNoAxeViolations();
  }, 40_000);

  it('sets the deposit against the invoice and pays back the excess', async () => {
    admit();
    addMockDeposit(HOSPITAL, 'adm_final', 200_000);
    await invoiceTheStay();
    renderApp({ entry: '/billing/stays/adm_final' });
    await waitFor(() => expect(screen.getByTestId('settle-held').textContent).toMatch(/2,000/));
    await userEvent.click(
      screen.getByRole('button', { name: 'Set the deposit against invoice INV-0001' }),
    );
    expect(await screen.findByText('Deposit of ₹901.00 set against the invoice.')).toBeVisible();
    await waitFor(() => expect(screen.getByTestId('settle-due').textContent).toMatch(/0\.00/));
    expect(mockInvoices()[0]?.status).toBe('paid');
    expect(screen.getByTestId('settle-excess').textContent).toMatch(/1,099\.00/);

    const amount = screen.getByRole('textbox', { name: /^Amount to pay back/ });
    expect(amount).toHaveValue('1099.00');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Paid back by/ }), 'upi');
    await userEvent.click(screen.getByRole('button', { name: 'Pay back deposit' }));
    expect(await screen.findAllByText(/is required|Required/i)).not.toHaveLength(0);
    await userEvent.type(screen.getByRole('textbox', { name: /^Refund reason/ }), 'Left over');
    await userEvent.click(screen.getByRole('button', { name: 'Pay back deposit' }));
    expect(await screen.findByText('Deposit of ₹1,099.00 paid back.')).toBeVisible();
    await waitFor(() => expect(screen.getByTestId('settle-excess').textContent).toMatch(/0\.00/));
    expect(screen.getByTestId('clearance')).toHaveTextContent('Nothing stands in the way');
    expect(screen.queryByRole('textbox', { name: /^Amount to pay back/ })).toBeNull();
  }, 60_000);

  it('refuses a refund of more than the excess', async () => {
    admit();
    addMockDeposit(HOSPITAL, 'adm_final', 200_000);
    await invoiceTheStay();
    renderApp({ entry: '/billing/stays/adm_final' });
    const amount = await screen.findByRole('textbox', { name: /^Amount to pay back/ });
    await userEvent.clear(amount);
    await userEvent.type(amount, '1100');
    await userEvent.type(screen.getByRole('textbox', { name: /^Refund reason/ }), 'Too much');
    await userEvent.click(screen.getByRole('button', { name: 'Pay back deposit' }));
    expect(await screen.findByText('More than the deposit held beyond what is due.')).toBeVisible();
  }, 40_000);

  it('offers no refund without payment:refund', async () => {
    revokePermission(HOSPITAL, 'admin', 'payment:refund');
    admit();
    addMockDeposit(HOSPITAL, 'adm_final', 200_000);
    await invoiceTheStay();
    renderApp({ entry: '/billing/stays/adm_final' });
    await waitFor(() => expect(screen.getByTestId('settle-held').textContent).toMatch(/2,000/));
    expect(screen.queryByRole('textbox', { name: /^Amount to pay back/ })).toBeNull();
  }, 40_000);

  it('is not reachable with the billing switch off', async () => {
    setTenantFeature(HOSPITAL, 'billing', false);
    admit();
    renderApp({ entry: '/billing/stays/adm_final' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeVisible();
  });

  it("does not show another hospital's stay", async () => {
    admit();
    for (const permission of ['admission:read', 'charge:read']) {
      grantPermission(TENANT_IDS.clinic, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/billing/stays/adm_final' });
    expect(await screen.findByText('This stay is not available.')).toBeVisible();
  });
});

describe('discharge and the bill', () => {
  const openPanel = async () => {
    renderApp({ entry: '/admissions' });
    const grid = await screen.findByRole('table', { name: 'Admissions' });
    await userEvent.click(await within(grid).findByRole('button', { name: /Discharge/ }));
    return screen.findByRole('region', { name: /Discharge / });
  };

  async function setPolicy(mode: 'off' | 'warn' | 'block') {
    const app = renderApp({ entry: '/billing/discharge-policy' });
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: /^When the bill/ }),
      mode,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('Policy saved.')).toBeVisible();
    app.unmount();
  }

  it('asks for a confirmation while the bill is unsettled (warn)', async () => {
    admit();
    const panel = await openPanel();
    expect(await within(panel).findByText('Charges are not invoiced yet.')).toBeVisible();
    const submit = within(panel).getByRole('button', { name: 'Discharge patient' });
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(submit);
    expect(screen.queryByText(/is discharged\./)).toBeNull();
    await userEvent.click(within(panel).getByRole('checkbox'));
    expect(submit).not.toHaveAttribute('aria-disabled');
    await userEvent.click(within(panel).getByRole('button', { name: 'Discharge patient' }));
    expect(await screen.findByText(/is discharged\./)).toBeInTheDocument();
  }, 40_000);

  it('does not allow discharge while the bill is unsettled (block)', async () => {
    admit();
    await setPolicy('block');
    const panel = await openPanel();
    expect(await within(panel).findByText(/does not allow discharge until it is/)).toBeVisible();
    const submit = within(panel).getByRole('button', { name: 'Discharge patient' });
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(submit);
    expect(screen.queryByText(/is discharged\./)).toBeNull();
  }, 40_000);

  it('does not look at the bill when the policy is off', async () => {
    admit();
    await setPolicy('off');
    const panel = await openPanel();
    await within(panel).findByRole('button', { name: 'Discharge patient' });
    expect(screen.queryByTestId('bill-gate')).toBeNull();
  }, 40_000);
});
