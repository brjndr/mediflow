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
import { mockInvoices } from '@/mocks/handlers/billing';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { previewDiscounts, spread } from './lib/discount';

// Discounts on invoices (#116). The sample visit's charges are 500.00 + 350.00 + 51.00 = 901.00;
// the hospital's limit is 5% of the bill until it sets another.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };

async function builder() {
  const app = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
  return app;
}

async function giveDiscount(target: string, value: string, kind = 'Percentage') {
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Applies to' }), target);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), kind);
  await userEvent.type(screen.getByRole('textbox', { name: /^Discount/ }), value);
  await userEvent.click(screen.getByRole('button', { name: 'Add discount' }));
}

/** A draft of the sample charges with a 10% discount on the whole bill, made by the signed-in user. */
async function pendingDraft(): Promise<string> {
  const response = await fetch('/api/encounters/enc_h_1/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      chargeIds: ['chg_h_1', 'chg_h_2', 'chg_h_3'],
      manualLines: [],
      billDiscount: { kind: 'percent', value: 1000, reason: 'charity' },
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe('the sums', () => {
  it('spread a bill discount so the shares add up', () => {
    expect(spread([1000n, 1000n, 1000n], 100n)).toEqual([34n, 33n, 33n]);
    const preview = previewDiscounts(
      [
        { totalMinor: 10000, discount: { kind: 'percent', value: 5000, reason: 'staff' } },
        { totalMinor: 10000 },
      ],
      { kind: 'percent', value: 1000, reason: 'staff' },
    );
    expect(preview.own).toEqual([5000, 0]);
    expect(preview.shares).toEqual([500, 1000]);
    expect(preview.discountMinor).toBe(6500);
  });

  it('say when a discount takes more than it comes off', () => {
    expect(
      previewDiscounts([
        { totalMinor: 100, discount: { kind: 'amount', value: 101, reason: 'staff' } },
      ]).exceeds,
    ).toBe(true);
  });
});

describe('giving a discount in the builder', () => {
  it('takes a line discount off before the total, with no approval within the limit', async () => {
    await builder();
    await giveDiscount('Complete blood count', '10');
    await waitFor(() => expect(screen.getByTestId('invoice-discount')).toHaveTextContent('35.00'));
    expect(screen.getByTestId('invoice-gross')).toHaveTextContent('901.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('866.00');
    expect(screen.queryByTestId('discount-needs-approval')).toBeNull();
    expect(screen.getByRole('table', { name: 'Discounts' })).toHaveTextContent('Goodwill');
  });

  it('takes a discount off the whole bill, and says it needs approval above the limit', async () => {
    await builder();
    await giveDiscount('Whole bill', '10');
    await waitFor(() => expect(screen.getByTestId('invoice-discount')).toHaveTextContent('90.10'));
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('810.90');
    expect(await screen.findByTestId('discount-needs-approval')).toHaveTextContent('5%');
  });

  it('refuses a value that is not a percentage, and an amount typed with a comma', async () => {
    await builder();
    await giveDiscount('Whole bill', '101');
    expect(await screen.findByText(/Type a percentage from 0.01 to 100/)).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-discount')).toBeNull();
    await userEvent.clear(screen.getByRole('textbox', { name: /^Discount/ }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'Amount');
    await userEvent.type(screen.getByRole('textbox', { name: /^Discount/ }), '12,50');
    await userEvent.click(screen.getByRole('button', { name: 'Add discount' }));
    expect(await screen.findByText(/Type an amount above nothing/)).toBeInTheDocument();
  });

  it('removes a discount again', async () => {
    await builder();
    await giveDiscount('Whole bill', '10');
    const grid = await screen.findByRole('table', { name: 'Discounts' });
    await userEvent.click(within(grid).getByRole('button', { name: /Remove discount/ }));
    await waitFor(() => expect(screen.queryByTestId('invoice-discount')).toBeNull());
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('901.00');
  });

  it('saves the discount with the draft and holds a large one for approval', async () => {
    await builder();
    await giveDiscount('Whole bill', '10');
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect(await screen.findByTestId('discount-pending')).toHaveTextContent('waits for approval');
    expect(mockInvoices()[0]).toMatchObject({ discountStatus: 'pending', discountMinor: 9010 });
    // Its maker may not approve it.
    expect(screen.queryByRole('button', { name: 'Approve discount' })).toBeNull();
    expect(screen.getByText(/someone else must approve/)).toBeInTheDocument();
  });

  it('does not issue a bill whose discount waits for approval', async () => {
    await builder();
    await giveDiscount('Whole bill', '10');
    await userEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    expect(await screen.findByTestId('discount-pending')).toBeInTheDocument();
    expect(mockInvoices()[0]).toMatchObject({ status: 'draft', discountStatus: 'pending' });
  });

  it('has no axe violations', async () => {
    const app = await builder();
    await giveDiscount('Whole bill', '10');
    await screen.findByTestId('invoice-discount');
    await expectNoAxeViolations(app.container);
  });
});

describe('approving a discount', () => {
  async function asSomeoneElse(permissions: string[]) {
    for (const permission of ['invoice:read', 'invoice:create', 'charge:read', ...permissions]) {
      grantPermission(HOSPITAL, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, HOSPITAL);
  }

  it('lets someone else approve it, and then the bill is issued with it', async () => {
    const id = await pendingDraft();
    await asSomeoneElse(['discount:approve', 'invoice:issue']);
    renderApp({ entry: `/billing/invoices/${id}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve discount' }));
    expect(await screen.findByText('Discount approved.')).toBeInTheDocument();
    expect(mockInvoices()[0]).toMatchObject({ discountStatus: 'approved' });
    await userEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    await screen.findByText('INV-0001');
    expect(screen.getByTestId('invoice-discount')).toHaveTextContent('90.10');
    expect(screen.getByTestId('discount-status')).toHaveTextContent('Approved');
    expect(mockInvoices()[0]).toMatchObject({ status: 'issued', discountMinor: 9010 });
  });

  it('offers no approval to the person who gave the discount, nor to one without the right', async () => {
    const id = await pendingDraft();
    const app = renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByTestId('discount-pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve discount' })).toBeNull();
    app.unmount();
    await asSomeoneElse([]);
    renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByTestId('discount-pending')).toHaveTextContent('waits for approval');
    expect(screen.queryByRole('button', { name: 'Approve discount' })).toBeNull();
  });

  it('is refused by the server for the person who gave it', async () => {
    const id = await pendingDraft();
    const draft = mockInvoices()[0];
    const response = await fetch(`/api/invoices/${id}/discount-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ version: draft?.version }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'own_discount',
    );
  });
});

describe('who may give a discount', () => {
  it('needs discount:apply: the panel is not offered without it', async () => {
    revokePermission(HOSPITAL, 'admin', 'discount:apply');
    await builder();
    expect(screen.queryByRole('heading', { name: 'Discounts' })).toBeNull();
  });

  it('refuses a discount from the server for a caller without it', async () => {
    revokePermission(HOSPITAL, 'admin', 'discount:apply');
    const response = await fetch('/api/encounters/enc_h_1/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        chargeIds: ['chg_h_1'],
        manualLines: [],
        billDiscount: { kind: 'percent', value: 100, reason: 'staff' },
      }),
    });
    expect(response.status).toBe(403);
  });
});

describe('the discount limit', () => {
  it('starts at 5% and is saved as a percentage', async () => {
    renderApp({ entry: '/billing/discount-limit' });
    const limit = await screen.findByRole('textbox', { name: /^Limit/ });
    expect(limit).toHaveValue('5');
    await userEvent.clear(limit);
    await userEvent.type(limit, '12.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText(/Limit saved/)).toBeInTheDocument();
    const body = (await (await fetch('/api/billing/discount-settings')).json()) as {
      limitBp: number;
    };
    expect(body.limitBp).toBe(1250);
  });

  it('moves what needs approval', async () => {
    const put = await fetch('/api/billing/discount-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ limitBp: 2000 }),
    });
    expect(put.status).toBe(200);
    await builder();
    await giveDiscount('Whole bill', '10');
    await screen.findByTestId('invoice-discount');
    expect(screen.queryByTestId('discount-needs-approval')).toBeNull();
  });

  it('refuses what is not a percentage', async () => {
    renderApp({ entry: '/billing/discount-limit' });
    const limit = await screen.findByRole('textbox', { name: /^Limit/ });
    await userEvent.clear(limit);
    await userEvent.type(limit, '5,5');
    await userEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText(/Type a percentage from 0 to 100/)).toBeInTheDocument();
  });

  it('is each hospital’s own', async () => {
    await fetch('/api/billing/discount-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ limitBp: 2000 }),
    });
    for (const permission of ['invoice:read', 'discount:manage']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/billing/discount-limit' });
    expect(await screen.findByRole('textbox', { name: /^Limit/ })).toHaveValue('5');
  });

  it('needs discount:manage, is linked from the list for it only, and needs billing switched on', async () => {
    const app = renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('link', { name: 'Discount limit' })).toHaveAttribute(
      'href',
      '/billing/discount-limit',
    );
    app.unmount();
    revokePermission(HOSPITAL, 'admin', 'discount:manage');
    renderApp({ entry: '/billing/invoices' });
    await screen.findByRole('heading', { name: 'Invoices' });
    expect(screen.queryByRole('link', { name: 'Discount limit' })).toBeNull();
  });

  it('is unreachable without the permission or with billing off', async () => {
    revokePermission(HOSPITAL, 'admin', 'discount:manage');
    const app = renderApp({ entry: '/billing/discount-limit' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    app.unmount();
    grantPermission(HOSPITAL, 'admin', 'discount:manage');
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: '/billing/discount-limit' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const app = renderApp({ entry: '/billing/discount-limit' });
    await screen.findByRole('textbox', { name: /^Limit/ });
    await expectNoAxeViolations(app.container);
  });
});
