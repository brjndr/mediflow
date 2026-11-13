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
import { mockCharges } from '@/mocks/handlers/billing';
import { addMockDeposit } from '@/mocks/handlers/stay-bill';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The running bill of an inpatient stay (DS-03, #166) on the hospital's open visit enc_h_1, whose
// ledger holds 500.00 + 350.00 + 51.00. Three days in a bed at 2,000.00 a day add 6,000.00.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };
const DAY = 86_400_000;

function admit(id = 'adm_bill') {
  addMockAdmission({
    id,
    encounterId: 'enc_h_1',
    patientName: 'Asha Verma',
    patientMrn: 'MRN-0042',
    stays: [
      {
        assignmentId: 'asg_1',
        bedId: 'bed_1',
        bedNumber: 'B1',
        wardId: 'w_1',
        wardName: 'Ward 1',
        bedCategoryId: 'general',
        dayPriceMinor: 200_000,
        assignedAt: new Date(Date.now() - 2 * DAY).toISOString(),
      },
    ],
  });
  return id;
}

const total = (name: string) => screen.findByTestId(name);

describe('the running bill of a stay', () => {
  it('adds up the charge ledger and the bed days so far', async () => {
    renderApp({ entry: `/billing/stays/${admit()}` });
    expect(await screen.findByRole('heading', { name: 'Running bill', level: 1 })).toBeVisible();
    const ledger = mockCharges()
      .filter((charge) => charge.encounterId === 'enc_h_1' && charge.status !== 'void')
      .reduce((sum, charge) => sum + charge.totalMinor, 0);
    expect(ledger).toBe(90_100);
    // Charges to date: the ledger and the bed days, as one figure the server worked out.
    expect((await total('charges-total')).textContent).toMatch(/6,901\.00/);
    const grid = screen.getByRole('table', { name: 'Running bill' });
    expect(within(grid).getByText('Bed days to date')).toBeInTheDocument();
    expect(within(grid).getByText('Services')).toBeInTheDocument();
    expect((await total('balance')).textContent).toMatch(/6,901\.00/);
    await expectNoAxeViolations();
  }, 20_000);

  it('takes a deposit and shows it against the balance', async () => {
    renderApp({ entry: `/billing/stays/${admit()}` });
    await total('charges-total');
    await userEvent.type(screen.getByRole('textbox', { name: /^Deposit amount/ }), '1000');
    await userEvent.click(screen.getByRole('button', { name: 'Take deposit' }));
    expect(await screen.findByText('Deposit of ₹1,000.00 taken.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('deposits-total').textContent).toMatch(/1,000/));
    expect(screen.getByTestId('balance').textContent).toMatch(/5,901\.00/);
    const list = screen.getByRole('table', { name: 'Deposits' });
    expect(await within(list).findAllByRole('row')).toHaveLength(2);
  }, 20_000);

  it('shows a balance in credit in words when the deposits are more than the charges', async () => {
    addMockDeposit(HOSPITAL, admit(), 1_000_000);
    renderApp({ entry: '/billing/stays/adm_bill' });
    expect(await screen.findByText('In credit')).toBeInTheDocument();
    expect(screen.getByTestId('balance').textContent).toMatch(/3,099\.00/);
  });

  it('keeps an estimate and says how far the charges are from it', async () => {
    renderApp({ entry: `/billing/stays/${admit()}` });
    await total('charges-total');
    await userEvent.type(screen.getByRole('textbox', { name: /^Estimate/ }), '5000');
    await userEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    expect(await screen.findByText('Estimate saved.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('estimate-summary').textContent).toMatch(/over it by ₹1,901\.00/),
    );
  }, 20_000);

  it('refuses a deposit that is nothing', async () => {
    renderApp({ entry: `/billing/stays/${admit()}` });
    await total('charges-total');
    await userEvent.type(screen.getByRole('textbox', { name: /^Deposit amount/ }), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Take deposit' }));
    expect(await screen.findByText('Enter more than nothing.')).toBeInTheDocument();
  });

  it('offers no deposit form after discharge', async () => {
    addMockAdmission({ id: 'adm_done', encounterId: 'enc_h_1', status: 'discharged' });
    renderApp({ entry: '/billing/stays/adm_done' });
    expect(await screen.findByText(/The patient has been discharged\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take deposit' })).not.toBeInTheDocument();
  });

  it('leaves out the deposit form without payment:create and the list without payment:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'payment:create');
    revokePermission(HOSPITAL, 'admin', 'payment:read');
    renderApp({ entry: `/billing/stays/${admit()}` });
    await total('charges-total');
    expect(screen.queryByRole('button', { name: 'Take deposit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Deposits' })).not.toBeInTheDocument();
  });

  it('has no estimate form without invoice:create', async () => {
    revokePermission(HOSPITAL, 'admin', 'invoice:create');
    renderApp({ entry: `/billing/stays/${admit()}` });
    await total('charges-total');
    expect(screen.queryByRole('button', { name: 'Save estimate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Make an interim bill' })).not.toBeInTheDocument();
  });

  it('links an interim bill to the invoice builder of the stay’s visit', async () => {
    renderApp({ entry: `/billing/stays/${admit()}` });
    await total('charges-total');
    expect(screen.getByRole('link', { name: 'Make an interim bill' })).toHaveAttribute(
      'href',
      '/billing/new?encounterId=enc_h_1',
    );
  });

  it('gives no access without charge:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'charge:read');
    renderApp({ entry: `/billing/stays/${admit()}` });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable with billing off, and another hospital’s stay is not found', async () => {
    setTenantFeature(HOSPITAL, 'billing', false);
    const off = renderApp({ entry: `/billing/stays/${admit()}` });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    off.unmount();
    setTenantFeature(HOSPITAL, 'billing', true);
    for (const permission of ['admission:read', 'charge:read']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/billing/stays/adm_bill' });
    expect(await screen.findByText('This stay is not available.')).toBeInTheDocument();
  });

  it('says so for a stay that does not exist', async () => {
    renderApp({ entry: '/billing/stays/adm_nobody' });
    expect(await screen.findByText('This stay is not available.')).toBeInTheDocument();
  });
});
