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
import { mockCharges, mockInvoices } from '@/mocks/handlers/billing';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Tax on invoices (#119). The sample visit's charges are 500.00 + 350.00 + 51.00; here the blood
// count is in the standard class, 12% by default: 42.00 of tax, 943.00 owed.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };

type Charge = { taxClass?: string };
const taxTheBloodCount = () => {
  const charge = mockCharges().find((each) => each.id === 'chg_h_2');
  (charge as Charge).taxClass = 'standard';
};

async function setRates(items: { taxClass: string; rateBp: number }[]) {
  const response = await fetch('/api/billing/tax-rates', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ items }),
  });
  expect(response.status).toBe(200);
}

async function builder() {
  renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
}

describe('the invoice builder', () => {
  it('shows the tax before saving: before tax, the tax and the total', async () => {
    taxTheBloodCount();
    await builder();
    await waitFor(() => expect(screen.getByTestId('invoice-tax')).toHaveTextContent('42.00'));
    expect(screen.getByTestId('invoice-subtotal')).toHaveTextContent('901.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('943.00');
  });

  it('shows no tax lines when nothing is taxed', async () => {
    await builder();
    expect(await screen.findByTestId('invoice-total')).toHaveTextContent('901.00');
    expect(screen.queryByTestId('invoice-tax')).toBeNull();
  });

  it('has the server work the tax out when the bill is issued, and keeps it after the rates change', async () => {
    taxTheBloodCount();
    await builder();
    await waitFor(() => expect(screen.getByTestId('invoice-tax')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    await screen.findByText('INV-0001');
    expect(screen.getByTestId('invoice-tax')).toHaveTextContent('42.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('943.00');
    const issued = mockInvoices()[0];
    expect(issued).toMatchObject({ taxMinor: 4200, totalMinor: 94300 });
    expect(issued?.lines.find((line) => line.taxRateBp > 0)).toMatchObject({
      taxClass: 'standard',
      taxRateBp: 1200,
      taxMinor: 4200,
    });

    await setRates([{ taxClass: 'standard', rateBp: 1800 }]);
    expect(mockInvoices()[0]).toMatchObject({ taxMinor: 4200, totalMinor: 94300 });
  });
});

describe('the tax rates', () => {
  it('start from the defaults, and are saved as a percentage', async () => {
    renderApp({ entry: '/billing/tax-rates' });
    const standard = await screen.findByRole('textbox', { name: /^Standard rate/ });
    expect(standard).toHaveValue('12');
    expect(screen.getByRole('textbox', { name: /^Exempt/ })).toHaveValue('0');
    await userEvent.clear(standard);
    await userEvent.type(standard, '12.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save rates' }));
    expect(await screen.findByText(/Tax rates saved/)).toBeInTheDocument();
    const response = await fetch('/api/billing/tax-rates');
    const body = (await response.json()) as { items: { taxClass: string; rateBp: number }[] };
    expect(body.items.find((item) => item.taxClass === 'standard')?.rateBp).toBe(1250);
  });

  it('refuses what is not a percentage, and sends nothing', async () => {
    renderApp({ entry: '/billing/tax-rates' });
    const higher = await screen.findByRole('textbox', { name: /^Higher rate/ });
    await userEvent.clear(higher);
    await userEvent.type(higher, '18,5');
    await userEvent.click(screen.getByRole('button', { name: 'Save rates' }));
    expect(await screen.findByText(/Type a percentage from 0 to 100/)).toBeInTheDocument();
    const response = await fetch('/api/billing/tax-rates');
    const body = (await response.json()) as { items: { taxClass: string; rateBp: number }[] };
    expect(body.items.find((item) => item.taxClass === 'higher')?.rateBp).toBe(1800);
  });

  it('has no axe violations', async () => {
    const app = renderApp({ entry: '/billing/tax-rates' });
    await screen.findByRole('textbox', { name: /^Standard rate/ });
    await expectNoAxeViolations(app.container);
  });
});

describe('who reaches the tax rates', () => {
  it('needs taxRate:manage: no screen and no link without it', async () => {
    revokePermission(HOSPITAL, 'admin', 'taxRate:manage');
    renderApp({ entry: '/billing/tax-rates' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('links to them from the invoice list for taxRate:manage only', async () => {
    const app = renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('link', { name: 'Tax rates' })).toHaveAttribute(
      'href',
      '/billing/tax-rates',
    );
    app.unmount();
    revokePermission(HOSPITAL, 'admin', 'taxRate:manage');
    renderApp({ entry: '/billing/invoices' });
    await screen.findByRole('heading', { name: 'Invoices' });
    expect(screen.queryByRole('link', { name: 'Tax rates' })).toBeNull();
  });

  it('is unreachable when the hospital has billing switched off', async () => {
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: '/billing/tax-rates' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is each hospital’s own', async () => {
    await setRates([{ taxClass: 'standard', rateBp: 2000 }]);
    for (const permission of ['invoice:read', 'taxRate:manage']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/billing/tax-rates' });
    expect(await screen.findByRole('textbox', { name: /^Standard rate/ })).toHaveValue('12');
  });
});
