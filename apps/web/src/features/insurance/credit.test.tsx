import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { accountReconciles, receiptReconciles, statementReconciles } from './credit';
import type { CreditAccount, CreditStatement, Receipt } from './types';

// Corporate credit billing (#185). The sample hospital has Acme Industries with a limit of
// 50,000.00, 30 days to pay, bills CB-000001 (12,000.00, 55 days old and past due, 5,000.00 paid
// by receipt RC-000001) and CB-000002 (8,000.00): 15,000.00 owed, 7,000.00 of it overdue. The
// clinic has no corporate.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

beforeEach(() => {
  vi.stubGlobal('print', vi.fn());
});

const account: CreditAccount = {
  payerId: 'p',
  payerName: 'P',
  creditLimitMinor: 1000,
  termsDays: 30,
  billedMinor: 700,
  receivedMinor: 200,
  outstandingMinor: 500,
  overdueMinor: 100,
  availableMinor: 500,
  version: 1,
};
const statement: CreditStatement = {
  payerId: 'p',
  payerName: 'P',
  from: '2026-01-01',
  to: '2026-02-01',
  openingMinor: 100,
  billedMinor: 600,
  receivedMinor: 200,
  closingMinor: 500,
  items: [],
  nextCursor: null,
};

describe('the reconciliation checks', () => {
  it('say when an account, a statement or a receipt does not add up', () => {
    expect(accountReconciles(account)).toBe(true);
    expect(accountReconciles({ ...account, receivedMinor: 100 })).toBe(false);
    expect(accountReconciles({ ...account, overdueMinor: 600 })).toBe(false);

    expect(statementReconciles(statement, account, true)).toBe(true);
    expect(statementReconciles({ ...statement, closingMinor: 400 }, account, true)).toBe(false);
    // A period that ended before today is not compared with what is owed now.
    expect(statementReconciles(statement, { ...account, outstandingMinor: 900 }, false)).toBe(true);
    expect(statementReconciles(statement, { ...account, outstandingMinor: 900 }, true)).toBe(false);

    const receipt: Receipt = {
      id: 'r',
      number: 'RC-1',
      payerId: 'p',
      payerName: 'P',
      receivedOn: '2026-01-01',
      method: 'cash',
      amountMinor: 300,
      allocations: [
        { billId: 'a', billNumber: 'A', amountMinor: 100 },
        { billId: 'b', billNumber: 'B', amountMinor: 200 },
      ],
    };
    expect(receiptReconciles(receipt)).toBe(true);
    expect(receiptReconciles({ ...receipt, amountMinor: 350 })).toBe(false);
  });
});

describe('the credit account list', () => {
  it('lists the accounts with what is owed and has no axe violations', async () => {
    renderApp({ entry: '/credit' });
    const link = await screen.findByRole('link', { name: 'Acme Industries' });
    const row = link.closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/15,000\.00/)).toBeVisible();
    expect(within(row as HTMLElement).getByText(/35,000\.00/)).toBeVisible();
    await expectNoAxeViolations();
  });

  it('shows the clinic none of the hospital accounts', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    grantPermission(CLINIC, 'doctor', 'receivable:read');
    setTenantFeature(CLINIC, 'insurance', true);
    renderApp({ entry: '/credit' });
    expect(await screen.findByText(/No corporate has a credit account yet/)).toBeVisible();
    expect(screen.queryByText('Acme Industries')).toBeNull();
  });

  it('is not reachable without receivable:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'receivable:read');
    renderApp({ entry: '/credit' });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Acme Industries' })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Corporate credit' })).toBeNull();
  });

  it('is not reachable with the insurance module off', async () => {
    setTenantFeature(HOSPITAL, 'insurance', false);
    renderApp({ entry: '/credit' });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Acme Industries' })).toBeNull());
  });
});

describe('a credit account', () => {
  it('shows figures that add up: billed less received is owed, on the account and the statement', async () => {
    renderApp({ entry: '/credit/pyr_h_acme' });
    await screen.findByRole('heading', { name: 'Credit account: Acme Industries', level: 1 });
    expect(await screen.findByTestId('credit-billed')).toHaveTextContent('20,000.00');
    expect(screen.getByTestId('credit-received')).toHaveTextContent('5,000.00');
    expect(screen.getByTestId('credit-outstanding')).toHaveTextContent('15,000.00');
    expect(screen.getByTestId('credit-overdue')).toHaveTextContent('7,000.00');
    expect(screen.getByTestId('credit-available')).toHaveTextContent('35,000.00');
    expect(screen.getByText('Owed is billed less received')).toBeVisible();

    // The statement for the last 90 days ends at what the account says is owed.
    expect(await screen.findByTestId('statement-closing')).toHaveTextContent('15,000.00');
    expect(screen.getByTestId('statement-opening')).toHaveTextContent('0.00');
    expect(screen.getByTestId('statement-billed')).toHaveTextContent('20,000.00');
    expect(screen.getByTestId('statement-received')).toHaveTextContent('5,000.00');
    expect(screen.getByText('The statement agrees with the account')).toBeVisible();

    // The older bill is overdue; the newer is not.
    const bills = screen.getByRole('table', { name: 'Bills' });
    expect(within(bills).getByRole('row', { name: /CB-000001/ })).toHaveTextContent('Overdue');
    expect(within(bills).getByRole('row', { name: /CB-000002/ })).toHaveTextContent('Unpaid');
    await expectNoAxeViolations();
  });

  it('sets a receipt against the oldest bill first and keeps the account reconciled', async () => {
    renderApp({ entry: '/credit/pyr_h_acme' });
    await screen.findByTestId('credit-outstanding');
    await userEvent.click(screen.getByRole('button', { name: 'Record a receipt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record a receipt' });
    // More than is owed is refused before it is sent.
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), '16000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record receipt' }));
    expect(await within(dialog).findByText('This is more than the corporate owes.')).toBeVisible();

    await userEvent.clear(within(dialog).getByLabelText(/^Amount/));
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), '8000');
    await userEvent.type(within(dialog).getByLabelText('Reference'), 'NEFT-9001');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record receipt' }));

    // 7,000.00 clears the older bill, 1,000.00 goes to the newer.
    const done = await screen.findByRole('dialog', { name: /^Receipt RC-/ });
    expect(within(done).getByText('CB-000001')).toBeVisible();
    expect(within(done).getByText('CB-000002')).toBeVisible();
    expect(within(done).getByText('The receipt is fully set against bills')).toBeVisible();
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }));

    await waitFor(() =>
      expect(screen.getByTestId('credit-outstanding')).toHaveTextContent('7,000.00'),
    );
    expect(screen.getByTestId('credit-received')).toHaveTextContent('13,000.00');
    expect(screen.getByText('Owed is billed less received')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('statement-closing')).toHaveTextContent('7,000.00'),
    );
    expect(screen.getByText('The statement agrees with the account')).toBeVisible();
    const bills = screen.getByRole('table', { name: 'Bills' });
    expect(within(bills).getByRole('row', { name: /CB-000001/ })).toHaveTextContent('Paid');
  });

  it('prints a receipt', async () => {
    renderApp({ entry: '/credit/pyr_h_acme' });
    const receipts = await screen.findByRole('table', { name: 'Receipts' });
    await userEvent.click(await within(receipts).findByRole('button', { name: 'Print RC-000001' }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it('changes the terms and refuses a limit below what is owed', async () => {
    renderApp({ entry: '/credit/pyr_h_acme' });
    await screen.findByTestId('credit-limit');
    await userEvent.click(screen.getByRole('button', { name: 'Change credit terms' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change credit terms' });
    const limit = within(dialog).getByLabelText(/Credit limit/);
    await userEvent.clear(limit);
    await userEvent.type(limit, '1000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The limit cannot be below what the corporate already owes.',
    );
    await userEvent.clear(limit);
    await userEvent.type(limit, '90000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('credit-limit')).toHaveTextContent('90,000.00'));
    expect(screen.getByText('The credit terms were saved.')).toBeVisible();
  });

  it('offers no receipt or terms without the permissions', async () => {
    revokePermission(HOSPITAL, 'admin', 'receivable:receipt');
    revokePermission(HOSPITAL, 'admin', 'receivable:manage');
    renderApp({ entry: '/credit/pyr_h_acme' });
    await screen.findByTestId('credit-outstanding');
    expect(screen.queryByRole('button', { name: 'Record a receipt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change credit terms' })).toBeNull();
  });

  it('offers to open an account for a corporate without one, and not for an insurer', async () => {
    renderApp({ entry: '/credit/pyr_h_star' });
    expect(await screen.findByRole('heading', { name: 'No credit account' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Open a credit account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a credit account' });
    await userEvent.type(within(dialog).getByLabelText(/Credit limit/), '1000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only a corporate can have a credit account.',
    );
  });

  it('does not show an account of another hospital', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    grantPermission(CLINIC, 'doctor', 'receivable:read');
    setTenantFeature(CLINIC, 'insurance', true);
    renderApp({ entry: '/credit/pyr_h_acme' });
    expect(await screen.findByRole('heading', { name: 'No credit account' })).toBeVisible();
    expect(screen.queryByText('Acme Industries')).toBeNull();
  });
});

describe('billing a visit to credit', () => {
  it('puts the visit on a corporate account within the limit, once', async () => {
    const { unmount } = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    const panel = await screen.findByRole('region', { name: 'Bill to a corporate on credit' });
    await userEvent.selectOptions(within(panel).getByLabelText('Corporate'), 'pyr_h_acme');
    await userEvent.click(within(panel).getByRole('button', { name: 'Bill on credit' }));
    expect(await within(panel).findByText(/901\.00 was put on Acme Industries/)).toBeVisible();
    unmount();

    // The account now owes 15,901.00, and a second bill for the same visit is refused.
    renderApp({ entry: '/credit/pyr_h_acme' });
    expect(await screen.findByTestId('credit-outstanding')).toHaveTextContent('15,901.00');
    expect(screen.getByText('Owed is billed less received')).toBeVisible();
  });

  it('refuses a second credit bill for the same visit', async () => {
    const first = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    let panel = await screen.findByRole('region', { name: 'Bill to a corporate on credit' });
    await userEvent.selectOptions(within(panel).getByLabelText('Corporate'), 'pyr_h_acme');
    await userEvent.click(within(panel).getByRole('button', { name: 'Bill on credit' }));
    await within(panel).findByText(/was put on/);
    first.unmount();

    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    panel = await screen.findByRole('region', { name: 'Bill to a corporate on credit' });
    await userEvent.selectOptions(within(panel).getByLabelText('Corporate'), 'pyr_h_acme');
    await userEvent.click(within(panel).getByRole('button', { name: 'Bill on credit' }));
    expect(await within(panel).findByText('This visit is already billed to credit.')).toBeVisible();
  });

  it('offers nothing without receivable:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'receivable:manage');
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    await screen.findByRole('region', { name: 'Split between the patient and the payer' });
    expect(screen.queryByRole('region', { name: 'Bill to a corporate on credit' })).toBeNull();
  });
});
