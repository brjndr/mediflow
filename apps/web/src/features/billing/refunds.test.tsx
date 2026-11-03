import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import {
  mockCreditNotes,
  mockInvoices,
  mockPayments,
  setMockRegisterOpen,
} from '@/mocks/handlers/billing';
import { server } from '@/mocks/node';
import { error } from '@/mocks/respond';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Refunds (#444) on an invoice issued through the builder: 500.00 + 350.00 + 51.00 = 901.00.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };
const REFUND = { name: 'Refund payment' };

afterEach(() => {
  server.events.removeAllListeners();
  setMockRegisterOpen(true);
});

async function issueOne() {
  const app = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
  await screen.findByText('INV-0001');
  app.unmount();
  return mockInvoices()[0]?.id ?? '';
}

/** Takes one payment of `amount` in cash through the form, on the invoice's page. */
async function payOf(amount: string) {
  const field = screen.getByRole('textbox', { name: /^Amount/ });
  await userEvent.clear(field);
  await userEvent.type(field, amount);
  await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
  await waitFor(() => expect(mockPayments().filter((p) => p.kind === 'payment')).toHaveLength(1));
}

/** An invoice with 300.00 paid in cash, on its page. */
async function openPaid() {
  const id = await issueOne();
  renderApp({ entry: `/billing/invoices/${id}` });
  await screen.findByRole('heading', { name: 'Payments' });
  await payOf('300');
  await screen.findByRole('button', REFUND);
  return id;
}

const statusLine = () =>
  within(screen.getByRole('region', { name: 'Payments' })).getByRole('status');
async function messageShown() {
  await waitFor(() => expect(statusLine()).not.toBeEmptyDOMElement());
  return statusLine();
}
const amountField = () => screen.getByRole('textbox', { name: /^Refund amount/ });
const reasonField = () => screen.getByRole('textbox', { name: /^Refund reason/ });
const refunds = () => mockPayments().filter((p) => p.kind === 'refund');

async function refund(amount: string, reason = 'Charged twice') {
  await userEvent.clear(amountField());
  await userEvent.type(amountField(), amount);
  await userEvent.type(reasonField(), reason);
  await userEvent.click(screen.getByRole('button', REFUND));
}

describe('refunding a payment', () => {
  it('refunds part of a payment, shows it as negative, and keeps what is left', async () => {
    await openPaid();
    expect(amountField()).toHaveValue('300.00');
    await refund('120');
    expect(await messageShown()).toHaveTextContent('Refund of');
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]).toMatchObject({
      amountMinor: 12000,
      reason: 'Charged twice',
      method: 'cash',
    });
    const grid = await screen.findByRole('table', { name: 'Payments' });
    await within(grid).findByText(/^[-−].*120.00$/);
    // 180.00 is still held by the payment.
    await waitFor(() => expect(amountField()).toHaveValue('180.00'));
    await expectNoAxeViolations(document.body);
  }, 20000);

  it('lets the invoice take a credit note for the money refunded', async () => {
    await openPaid();
    await refund('300');
    await messageShown();
    // Nothing is held any more, so the form goes; the credit note form takes the unpaid amount.
    await waitFor(() => expect(screen.queryByRole('button', REFUND)).toBeNull());
    expect(mockInvoices()[0]?.status).toBe('issued');
    await userEvent.type(screen.getByRole('textbox', { name: /^Reason/ }), 'Billed in error');
    await userEvent.click(screen.getByRole('button', { name: 'Issue credit note' }));
    await waitFor(() => expect(mockCreditNotes()).toHaveLength(1));
    expect(mockCreditNotes()[0]?.amountMinor).toBe(90100);
  });

  it('moves focus to the message when the last of the money goes', async () => {
    await openPaid();
    await refund('300');
    const status = await messageShown();
    await waitFor(() => expect(status).toHaveFocus());
  });

  it('refuses a nothing amount, one above the payment, a comma and no reason', async () => {
    await openPaid();
    await userEvent.type(reasonField(), 'x');
    const cases: [string, RegExp][] = [
      ['0', /Enter more than nothing\./],
      ['300.01', /More than that payment still holds\./],
    ];
    for (const [amount, message] of cases) {
      await userEvent.clear(amountField());
      await userEvent.type(amountField(), amount);
      await userEvent.click(screen.getByRole('button', REFUND));
      expect(await screen.findByText(message)).toBeInTheDocument();
    }
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '1,5');
    await userEvent.click(screen.getByRole('button', REFUND));
    await waitFor(() => expect(amountField()).toHaveAttribute('aria-invalid', 'true'));
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '10');
    await userEvent.clear(reasonField());
    await userEvent.click(screen.getByRole('button', REFUND));
    await waitFor(() => expect(reasonField()).toHaveAttribute('aria-invalid', 'true'));
    expect(refunds()).toHaveLength(0);
  });

  it('refunds once when the button is pressed twice', async () => {
    await openPaid();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '50');
    await userEvent.type(reasonField(), 'Overcharged');
    await userEvent.dblClick(screen.getByRole('button', REFUND));
    await messageShown();
    expect(refunds()).toHaveLength(1);
  });

  it('says so when a cash refund has no open register session', async () => {
    await openPaid();
    setMockRegisterOpen(false);
    await refund('50');
    expect(await messageShown()).toHaveTextContent(
      'A cash refund comes out of a cash register session',
    );
    expect(refunds()).toHaveLength(0);
  });

  it('says so when the payment holds less than was asked', async () => {
    await openPaid();
    server.use(
      http.post('*/api/payments/:paymentId/refunds', () =>
        error(409, 'refund_exceeds', 'More than the payment still holds'),
      ),
    );
    await refund('50');
    expect(await messageShown()).toHaveTextContent('more than the payment still holds');
  });
});

describe('refunding one of several payments', () => {
  it('moves focus to the message after a part refund, which makes the form again', async () => {
    await openPaid();
    await refund('120');
    const status = await messageShown();
    await waitFor(() => expect(status).toHaveFocus());
  });

  it('starts the amount as what the chosen payment holds, and a card refund needs no register', async () => {
    await openPaid();
    // A second payment, by card, 200.00.
    const paid = screen.getByRole('textbox', { name: /^Amount/ });
    await userEvent.clear(paid);
    await userEvent.type(paid, '200');
    await userEvent.selectOptions(screen.getByLabelText(/^Paid by/), 'card');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(mockPayments()).toHaveLength(2));

    const choose = await screen.findByLabelText(/^Payment to refund/);
    const options = within(choose).getAllByRole('option');
    // The most recent payment (the card) comes first.
    expect(options[0]).toHaveTextContent(/Card/);
    await waitFor(() => expect(amountField()).toHaveValue('200.00'));
    await userEvent.selectOptions(choose, options[1] as HTMLElement);
    await waitFor(() => expect(amountField()).toHaveValue('300.00'));
    await userEvent.selectOptions(choose, options[0] as HTMLElement);
    await waitFor(() => expect(amountField()).toHaveValue('200.00'));

    setMockRegisterOpen(false);
    await refund('50');
    await messageShown();
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]).toMatchObject({ method: 'card', amountMinor: 5000 });
  });
});

describe('who sees the refund form', () => {
  it('offers none without payment:refund, though payments are listed', async () => {
    const id = await issueOne();
    revokePermission(HOSPITAL, 'admin', 'payment:refund');
    renderApp({ entry: `/billing/invoices/${id}` });
    await screen.findByRole('heading', { name: 'Payments' });
    await payOf('300');
    expect(await screen.findByRole('table', { name: 'Payments' })).toBeInTheDocument();
    expect(screen.queryByRole('button', REFUND)).toBeNull();
  });

  it('offers none before anything has been paid', async () => {
    const id = await issueOne();
    renderApp({ entry: `/billing/invoices/${id}` });
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.queryByRole('button', REFUND)).toBeNull();
  });

  it('is unreachable when the hospital has billing switched off', async () => {
    const id = await issueOne();
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('keeps one hospital payments from another, and refuses its refund', async () => {
    await openPaid();
    const paymentId = mockPayments()[0]?.id ?? '';
    for (const permission of ['payment:read', 'payment:refund']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    const response = await fetch('/api/payments/' + paymentId + '/refunds', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-from-clinic-1' },
      body: JSON.stringify({ amountMinor: 100, reason: 'x' }),
    });
    expect(response.status).toBe(404);
    expect(refunds()).toHaveLength(0);
  });
});
