import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockCharges, mockCreditNotes, mockInvoices, mockPayments } from '@/mocks/handlers/billing';
import { server } from '@/mocks/node';
import { error } from '@/mocks/respond';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Credit notes (#112) on an invoice issued through the builder: 500.00 + 350.00 + 51.00 = 901.00.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };
const ISSUE = { name: 'Issue credit note' };

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
  await screen.findByRole('heading', { name: 'Credit notes' });
  return id;
}

const region = () => screen.getByRole('region', { name: 'Credit notes' });
const issueButton = () => screen.getByRole('button', ISSUE);
const amountField = () => screen.getByRole('textbox', { name: /^Credit amount/ });
const reasonField = () => screen.getByRole('textbox', { name: /^Reason/ });
async function messageShown() {
  await waitFor(() => expect(within(region()).getByRole('status')).not.toBeEmptyDOMElement());
  return within(region()).getByRole('status');
}

describe('an issued invoice', () => {
  it('cannot be edited: no builder, and the server refuses a change', async () => {
    const id = await openInvoice();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Pending charges' })).toBeNull();
    const response = await fetch(`/api/invoices/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chargeIds: ['chg_h_1'], manualLines: [], version: 1 }),
    });
    expect(response.status).toBe(409);
  });
});

describe('issuing a credit note', () => {
  it('credits part of the invoice with a reason', async () => {
    await openInvoice();
    expect(amountField()).toHaveValue('901.00');
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '350');
    await userEvent.type(reasonField(), 'Test not done');
    await userEvent.click(issueButton());

    expect(await messageShown()).toHaveTextContent('Credit note CN-0001 issued.');
    const grid = await screen.findByRole('table', { name: 'Credit notes' });
    expect(await within(grid).findByText('Test not done')).toBeInTheDocument();
    expect(mockCreditNotes()).toHaveLength(1);
    expect(mockInvoices()[0]?.status).toBe('issued');
    expect(mockInvoices()[0]?.creditedMinor).toBe(35000);
    await waitFor(() => expect(screen.getByTestId('balance-due')).toHaveTextContent('551.00'));
    await expectNoAxeViolations();
  });

  it('credits the whole invoice: it is void and its charges can be billed again', async () => {
    await openInvoice();
    await userEvent.type(reasonField(), 'Billed to the wrong visit');
    await userEvent.click(issueButton());
    await waitFor(() => expect(mockInvoices()[0]?.status).toBe('void'));
    expect(await screen.findByTestId('void-notice')).toHaveTextContent('credited in full');
    expect(screen.queryByRole('button', ISSUE)).toBeNull();
    const visit = mockCharges().filter((each) => each.encounterId === 'enc_h_1');
    expect(visit.length).toBeGreaterThan(0);
    expect(visit.every((each) => each.status === 'pending')).toBe(true);
    const status = within(region()).getByRole('status');
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it('refuses no reason, nothing, more than is left or a comma, and sends nothing', async () => {
    await openInvoice();
    await userEvent.click(issueButton());
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    await userEvent.type(reasonField(), 'Because');
    for (const [text, message] of [
      ['0', 'Enter more than nothing.'],
      ['901.01', 'More than can be credited.'],
      ['12,50', 'This value is not in the expected format.'],
    ] as const) {
      await userEvent.clear(amountField());
      await userEvent.type(amountField(), text);
      await userEvent.click(issueButton());
      expect(await screen.findByText(message)).toBeInTheDocument();
    }
    expect(mockCreditNotes()).toHaveLength(0);
  });

  it('issues one note when the button is pressed twice', async () => {
    await openInvoice();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '10');
    await userEvent.type(reasonField(), 'Rounding');
    await userEvent.dblClick(issueButton());
    await screen.findByText(/issued\.$/);
    expect(mockCreditNotes()).toHaveLength(1);
  });

  it('caps the credit at what is unpaid once part has been paid, and no longer says it voids', async () => {
    await openInvoice();
    expect(screen.getByText(/The whole invoice makes it void/)).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: /^Amount/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Amount/ }), '400');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(amountField()).toHaveValue('501.00'));
    expect(screen.queryByText(/The whole invoice makes it void/)).toBeNull();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), '501.01');
    await userEvent.type(reasonField(), 'Because');
    await userEvent.click(issueButton());
    expect(await screen.findByText('More than can be credited.')).toBeInTheDocument();
    expect(mockCreditNotes()).toHaveLength(0);
  });

  it('says to refund first once everything has been paid', async () => {
    await openInvoice();
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(mockPayments()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', ISSUE)).toBeNull());
    expect(screen.getByText(/Refund it before a credit note/)).toBeInTheDocument();
    expect(mockCreditNotes()).toHaveLength(0);
  });

  it('shows what the server refuses', async () => {
    await openInvoice();
    server.use(
      http.post('*/api/invoices/:invoiceId/credit-notes', () =>
        error(409, 'refund_first', 'Refund the money paid first'),
      ),
    );
    await userEvent.type(reasonField(), 'Because');
    await userEvent.click(issueButton());
    expect(await messageShown()).toHaveTextContent('Refund it first.');
    expect(mockCreditNotes()).toHaveLength(0);
  });
});

describe('who sees credit notes', () => {
  it('shows no form without creditNote:create, but lists the notes', async () => {
    const id = await issueOne();
    revokePermission(HOSPITAL, 'admin', 'creditNote:create');
    renderApp({ entry: `/billing/invoices/${id}` });
    await screen.findByRole('heading', { name: 'Credit notes' });
    expect(screen.queryByRole('button', ISSUE)).toBeNull();
    expect(await screen.findByRole('table', { name: 'Credit notes' })).toBeInTheDocument();
  });

  it('is unreachable when the hospital has billing switched off', async () => {
    const id = await issueOne();
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('keeps one hospital’s invoice and credit notes from another', async () => {
    const id = await issueOne();
    for (const permission of ['invoice:read', 'creditNote:create']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByText('This invoice is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Credit notes' })).toBeNull();
  });
});
