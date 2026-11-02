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
import { http, HttpResponse } from 'msw';
import { mockCharges, mockInvoices } from '@/mocks/handlers/billing';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The invoice builder (#109). The mock's hospital has three pending charges on the open
// consultation enc_h_1: a consultation (500.00), a blood count (350.00) and two strips of
// paracetamol (25.50 each), 901.00 in all; the clinic has a consultation of 150.00 on enc_c_1.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NEW = '/billing/new?encounterId=enc_h_1';
const NEW_HEADING = { name: 'New invoice', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const charges = () => screen.getByRole('table', { name: 'Pending charges' });
const total = () => screen.getByTestId('invoice-total');

async function openBuilder(entry = NEW) {
  const app = renderApp({ entry });
  await screen.findByRole('heading', NEW_HEADING);
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
  return app;
}

describe('building an invoice from a visit', () => {
  it('puts every pending charge on the bill, totals them, and lets some be left off', async () => {
    await openBuilder();
    expect(within(charges()).getByText('General consultation')).toBeInTheDocument();
    expect(total()).toHaveTextContent('₹901.00');
    expect(screen.getByText('3 lines on this bill')).toBeInTheDocument();

    await userEvent.click(
      within(charges()).getByRole('button', { name: 'Leave off the bill: Complete blood count' }),
    );
    expect(total()).toHaveTextContent('₹551.00');
    expect(screen.getByText('2 lines on this bill')).toBeInTheDocument();
    // The keyboard keeps its place: the button now says it does not apply.
    expect(
      within(charges()).getByRole('button', { name: 'Leave off the bill: Complete blood count' }),
    ).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(
      within(charges()).getByRole('button', { name: 'Add to the bill: Complete blood count' }),
    );
    expect(total()).toHaveTextContent('₹901.00');
    await expectNoAxeViolations();
  });

  it('adds a line typed in, priced on its digits in the hospital’s currency', async () => {
    await openBuilder();
    await userEvent.type(screen.getByLabelText(/^What it is for/), 'Copy of the records');
    await userEvent.clear(screen.getByRole('textbox', { name: /^Quantity/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Quantity/ }), '2');
    await userEvent.type(screen.getByLabelText(/^Price of one/), '10.50');
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));

    const lines = await screen.findByRole('table', { name: 'Other lines' });
    expect(within(lines).getByText('Copy of the records')).toBeInTheDocument();
    expect(total()).toHaveTextContent('₹922.00');

    await userEvent.click(
      within(lines).getByRole('button', { name: 'Remove line: Copy of the records' }),
    );
    expect(total()).toHaveTextContent('₹901.00');
    // Focus is not left on the page body.
    expect(document.body).not.toHaveFocus();
  });

  it('refuses a price written with a decimal comma, a bad quantity and a missing description', async () => {
    await openBuilder();
    await userEvent.type(screen.getByLabelText(/^What it is for/), 'Copy');
    await userEvent.clear(screen.getByRole('textbox', { name: /^Quantity/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Quantity/ }), '0');
    await userEvent.type(screen.getByLabelText(/^Price of one/), '12,50');
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));

    expect(await screen.findByText('Type a number from 1 to 9999.')).toBeInTheDocument();
    expect(
      screen.getByText('Type an amount with a point for the decimals, such as 12.50.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Other lines' })).toBeNull();
    expect(total()).toHaveTextContent('₹901.00');

    await userEvent.clear(screen.getByLabelText(/^What it is for/));
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
  });

  it('saves a draft, shows it, and issues it with a number that cannot then be changed', async () => {
    await openBuilder();
    await userEvent.click(
      within(charges()).getByRole('button', { name: 'Leave off the bill: Complete blood count' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    // The draft is its own page, holding what was chosen.
    expect(await screen.findByRole('heading', { name: 'Invoice', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(mockInvoices()).toHaveLength(1);
    expect(mockInvoices()[0]).toMatchObject({ status: 'draft', totalMinor: 55100 });
    const table = await screen.findByRole('table', { name: 'Pending charges' });
    await within(table).findByText('Complete blood count');
    expect(total()).toHaveTextContent('₹551.00');

    await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect(
      await screen.findByText(/^Invoice INV-0001 was issued on .+ and can no longer be changed.$/),
    ).toBeInTheDocument();
    expect(screen.getByText('INV-0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(total()).toHaveTextContent('₹551.00');
    expect(mockInvoices()[0]).toMatchObject({ status: 'issued', number: 'INV-0001' });
    // Billed charges are invoiced; the one left off is still to bill.
    expect(mockCharges().find((c) => c.id === 'chg_h_1')?.status).toBe('invoiced');
    expect(mockCharges().find((c) => c.id === 'chg_h_2')?.status).toBe('pending');
    await expectNoAxeViolations();
  });

  it('issues straight from a new bill, and offers the leftover charge on a new one', async () => {
    const first = await openBuilder();
    await userEvent.click(
      within(charges()).getByRole('button', { name: 'Leave off the bill: Complete blood count' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect(await screen.findByText('INV-0001')).toBeInTheDocument();

    // Back to a new bill of the same visit: only what is not billed.
    first.unmount();
    renderApp({ entry: NEW });
    await screen.findByRole('heading', NEW_HEADING);
    const table = await screen.findByRole('table', { name: 'Pending charges' });
    await within(table).findByText('Complete blood count');
    expect(within(table).queryByText('General consultation')).toBeNull();
    expect(total()).toHaveTextContent('₹350.00');
  });

  it('refuses an empty bill and says so', async () => {
    await openBuilder();
    for (const name of [
      'General consultation',
      'Complete blood count',
      'Paracetamol 500 mg, strip of 10',
    ]) {
      await userEvent.click(
        within(charges()).getByRole('button', { name: `Leave off the bill: ${name}` }),
      );
    }
    expect(total()).toHaveTextContent('₹0.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Put at least one line on the bill.')).toBeInTheDocument();
    expect(mockInvoices()).toHaveLength(0);
  });

  it('sends one request for a double click on save', async () => {
    await openBuilder();
    const save = screen.getByRole('button', { name: 'Save draft' });
    await userEvent.dblClick(save);
    await waitFor(() => expect(mockInvoices()).toHaveLength(1));
  });

  it('says so when a charge was taken by another draft meanwhile', async () => {
    await openBuilder();
    // Someone else drafts the blood count while this screen is open.
    const { api } = await import('@/shared/api');
    await api.POST('/encounters/{encounterId}/invoices', {
      params: { path: { encounterId: 'enc_h_1' }, header: { 'idempotency-key': 'other-desk-key' } },
      body: { chargeIds: ['chg_h_2'], manualLines: [] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText(/was billed or taken by another draft meanwhile/),
    ).toBeInTheDocument();
  });
});

describe('reaching the builder from the consultation', () => {
  it('offers "Create invoice" on a visit, and opens the builder for it', async () => {
    renderApp({ entry: '/encounters/enc_h_1' });
    const link = await screen.findByRole('link', { name: 'Create invoice' });
    expect(link).toHaveAttribute('href', NEW);
    await userEvent.click(link);
    expect(await screen.findByRole('heading', NEW_HEADING)).toBeInTheDocument();
  });

  it('offers nothing on a visit that was cancelled or without the permissions', async () => {
    revokePermission(HOSPITAL, 'admin', 'invoice:create');
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', { name: 'Consultation', level: 1 });
    expect(screen.queryByRole('link', { name: 'Create invoice' })).toBeNull();
  });
});

describe('who may build an invoice', () => {
  it('is unreachable without invoice:create, and without the billing module', async () => {
    revokePermission(HOSPITAL, 'admin', 'invoice:create');
    const app = renderApp({ entry: NEW });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    app.unmount();

    grantPermission(HOSPITAL, 'admin', 'invoice:create');
    setTenantFeature(HOSPITAL, 'billing', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: NEW });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable without charge:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'charge:read');
    renderApp({ entry: NEW });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('offers no issuing without invoice:issue, and keeps the draft', async () => {
    revokePermission(HOSPITAL, 'admin', 'invoice:issue');
    await openBuilder();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(mockInvoices()[0]?.status).toBe('draft');
  });

  it('gives a custom role without the invoice permissions no access', async () => {
    signIn(USER_IDS.billingClerk, CLINIC);
    renderApp({ entry: '/billing/new?encounterId=enc_c_1' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('shows another hospital’s visit as not available, and the clinic in its own currency', async () => {
    // A doctor of both hospitals, given the invoice permissions at the clinic only.
    for (const permission of ['charge:read', 'invoice:create', 'invoice:read']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    const app = renderApp({ entry: NEW });
    expect(await screen.findByText('This visit is not available.')).toBeInTheDocument();
    expect(screen.queryByText('General consultation')).toBeNull();
    app.unmount();

    renderApp({ entry: '/billing/new?encounterId=enc_c_1' });
    await screen.findByRole('heading', NEW_HEADING);
    await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
      'General consultation',
    );
    expect(total()).toHaveTextContent('AED');
    expect(total()).toHaveTextContent('150.00');
  });

  it('shows an invoice of another hospital as not available', async () => {
    await openBuilder();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    const id = mockInvoices()[0]?.id ?? '';

    for (const permission of ['invoice:read']) grantPermission(CLINIC, 'doctor', permission);
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: `/billing/invoices/${id}` });
    expect(await screen.findByText('This invoice is not available.')).toBeInTheDocument();
  });
});

describe('a draft the visit already has', () => {
  it('is offered to continue on a new bill, and holds what was chosen', async () => {
    const first = await openBuilder();
    await userEvent.click(
      within(charges()).getByRole('button', { name: 'Leave off the bill: Complete blood count' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    first.unmount();

    renderApp({ entry: NEW });
    await screen.findByRole('heading', NEW_HEADING);
    expect(
      await screen.findByText(/This visit has a draft invoice\. Continue it/),
    ).toBeInTheDocument();
    // The charges the draft holds are not offered a second time.
    const table = await screen.findByRole('table', { name: 'Pending charges' });
    expect(await within(table).findByText('Complete blood count')).toBeInTheDocument();
    expect(within(table).queryByText('General consultation')).toBeNull();
  });
});

describe('when issuing fails after the draft was made', () => {
  it('keeps one draft, however often it is pressed again', async () => {
    server.use(
      http.post('*/api/invoices/:invoiceId/issue', () =>
        HttpResponse.json(
          { error: { code: 'internal', message: 'down', requestId: 'req_x' } },
          { status: 500 },
        ),
      ),
    );
    await openBuilder();
    await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    // The draft has a page of its own, saying it was saved.
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(mockInvoices()).toHaveLength(1);
    expect(mockInvoices()[0]?.status).toBe('draft');
  });
});

describe('lines typed in', () => {
  it('need invoice:adjust: without it there is no form for them', async () => {
    revokePermission(HOSPITAL, 'admin', 'invoice:adjust');
    await openBuilder();
    expect(screen.queryByRole('textbox', { name: /^What it is for/ })).toBeNull();
    expect(total()).toHaveTextContent('₹901.00');
  });
});
