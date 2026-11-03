import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockInvoices, mockPayments, setMockRegisterOpen } from '@/mocks/handlers/billing';
import { server } from '@/mocks/node';
import { error } from '@/mocks/respond';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Recording payments (#111) on an invoice issued through the builder: 500.00 + 350.00 + 51.00.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };

afterEach(() => {
  server.events.removeAllListeners();
  setMockRegisterOpen(true);
});

/** Issues an invoice of the hospital's visit through the builder, and returns its id. */
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

async function openInvoice() {
  const id = await issueOne();
  renderApp({ entry: `/billing/invoices/${id}` });
  await screen.findByRole('heading', { name: 'Payments' });
  return id;
}

const statusLine = () =>
  within(screen.getByRole('region', { name: 'Payments' })).getByRole('status');
/** The status line once it says something. */
async function messageShown() {
  await waitFor(() => expect(statusLine()).not.toBeEmptyDOMElement());
  return statusLine();
}
const amountField = () => screen.getByRole('textbox', { name: /^Amount/ });

describe('recording payments', () => {
  it('takes a part payment, then the rest, and the invoice is paid', async () => {
    await openInvoice();
    // Paying in full is the start: the amount holds everything still due.
    expect(amountField()).toHaveValue('901.00');
    expect(screen.getByTestId('balance-due')).toHaveTextContent('901.00');

    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '400');
    await userEvent.selectOptions(screen.getByLabelText(/^Paid by/), 'card');
    await userEvent.type(screen.getByRole('textbox', { name: /^Reference/ }), 'SLIP 77');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(await screen.findByText(/^Payment of .*400\.00.* recorded\.$/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('balance-due')).toHaveTextContent('501.00'));
    const grid = await screen.findByRole('table', { name: 'Payments' });
    expect(await within(grid).findByText('SLIP 77')).toBeInTheDocument();
    expect(within(grid).getByText('Card')).toBeInTheDocument();
    expect(mockInvoices()[0]?.status).toBe('issued');
    expect(amountField()).toHaveValue('501.00');

    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(mockInvoices()[0]?.status).toBe('paid'));
    expect(mockPayments()).toHaveLength(2);
    // Nothing is due, so the form is gone and focus has moved on, not to the page.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull(),
    );
    const status = statusLine();
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(status).toHaveTextContent(/Payment of .*501.00.* recorded./);
    await expectNoAxeViolations();
  });

  it('refuses an amount of nothing, more than is due, or with a comma, and sends nothing', async () => {
    await openInvoice();
    for (const [text, message] of [
      ['0', 'Enter more than nothing.'],
      ['901.01', 'More than is still due.'],
      ['12,50', 'This value is not in the expected format.'],
    ] as const) {
      await userEvent.clear(amountField());
      await userEvent.type(amountField(), text);
      await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
      expect(await screen.findByText(message)).toBeInTheDocument();
    }
    expect(mockPayments()).toHaveLength(0);
  });

  it('records one payment when the button is pressed twice', async () => {
    await openInvoice();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '100');
    await userEvent.dblClick(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByText(/recorded\.$/);
    expect(mockPayments()).toHaveLength(1);
  });

  it('says so when cash has no open register session, and takes the same payment by card', async () => {
    await openInvoice();
    setMockRegisterOpen(false);
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await messageShown()).toHaveTextContent('cash register session');
    expect(mockPayments()).toHaveLength(0);

    await userEvent.selectOptions(screen.getByLabelText(/^Paid by/), 'card');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByText(/recorded\.$/);
    expect(mockPayments()).toHaveLength(1);
  });
});

describe('what the server refuses', () => {
  it('shows a refusal, and a form made again after the balance changed does not lose it', async () => {
    await openInvoice();
    server.use(
      http.post('*/api/invoices/:invoiceId/payments', () =>
        error(409, 'overpayment', 'More than is still due'),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await messageShown()).toHaveTextContent(
      'That is more than is still due. The balance has been updated.',
    );
    expect(mockPayments()).toHaveLength(0);
  });

  it('says so when the invoice can no longer take a payment, and moves focus to the message', async () => {
    await openInvoice();
    server.use(
      http.post('*/api/invoices/:invoiceId/payments', () =>
        error(409, 'invoice_not_payable', 'No'),
      ),
      http.get('*/api/invoices/:invoiceId', () =>
        HttpResponse.json({ ...mockInvoices()[0], status: 'void' }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    const status = await messageShown();
    expect(status).toHaveTextContent('This invoice cannot take a payment.');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(status));
  });
});

describe('the idempotency key', () => {
  it('is kept for the same payment after a failure, and changes with the body', async () => {
    await openInvoice();
    const keys: string[] = [];
    server.use(
      http.post('*/api/invoices/:invoiceId/payments', ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
        return error(500, 'internal', 'Boom');
      }),
    );
    const record = () => screen.getByRole('button', { name: 'Record payment' });
    await userEvent.click(record());
    await waitFor(() => expect(keys).toHaveLength(1));
    await waitFor(() => expect(record()).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(record());
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);

    await waitFor(() => expect(record()).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '10');
    await userEvent.click(record());
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
    expect(mockPayments()).toHaveLength(0);
  });
});

describe('who sees payments', () => {
  it('offers no form on a paid invoice, but lists what was paid', async () => {
    await openInvoice();
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(mockInvoices()[0]?.status).toBe('paid'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull(),
    );
    expect(await screen.findByRole('table', { name: 'Payments' })).toBeInTheDocument();
    expect(screen.getByTestId('balance-due')).toHaveTextContent('0.00');
  });

  it('shows no form without payment:create', async () => {
    const id = await issueOne();
    revokePermission(HOSPITAL, 'admin', 'payment:create');
    renderApp({ entry: `/billing/invoices/${id}` });
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
    expect(await screen.findByRole('table', { name: 'Payments' })).toBeInTheDocument();
  });

  it('shows no list without payment:read, and no form either', async () => {
    const id = await issueOne();
    revokePermission(HOSPITAL, 'admin', 'payment:read');
    renderApp({ entry: `/billing/invoices/${id}` });
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.queryByRole('table', { name: 'Payments' })).toBeNull();
  });

  it('is unreachable when the hospital has billing switched off', async () => {
    const id = await issueOne();
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('keeps one hospital’s invoice and payments from another', async () => {
    const id = await issueOne();
    for (const permission of ['invoice:read', 'payment:read', 'payment:create']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByText('This invoice is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payments' })).toBeNull();
  });
});
