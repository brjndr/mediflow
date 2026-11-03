import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockInvoices, mockPrints } from '@/mocks/handlers/billing';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The invoice list and the print view (#110), on the mock's two pending charges kept apart from
// the builder's tests: each test makes the invoices it needs through the builder's screens.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };
const LIST_HEADING = { name: 'Invoices', level: 1 };

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal('print', print);
});
afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
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

describe('the invoice list', () => {
  it('shows the hospital’s invoices, finds one by number, and reads empty when none match', async () => {
    await issueOne();
    renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('heading', LIST_HEADING)).toBeInTheDocument();
    const grid = await screen.findByRole('table', { name: 'Invoices' });
    expect(await within(grid).findByRole('link', { name: 'INV-0001' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/billing\/invoices\//),
    );
    expect(await screen.findByText('1 invoice')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Find an invoice' }), 'zzz');
    expect(await screen.findByText('No invoice matches.')).toBeInTheDocument();
    // What was typed is not in the address.
    expect(window.location.href).not.toContain('zzz');

    // Words in any order, as the API matches them: the number and part of the patient's name.
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Find an invoice' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find an invoice' }), '0001 inv');
    expect(await within(grid).findByRole('link', { name: 'INV-0001' })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('filters by status', async () => {
    await issueOne();
    renderApp({ entry: '/billing/invoices' });
    const grid = await screen.findByRole('table', { name: 'Invoices' });
    await within(grid).findByRole('link', { name: 'INV-0001' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'void');
    expect(await screen.findByText('No invoice matches.')).toBeInTheDocument();
  });

  it('is in the navigation and reachable with invoice:read, and not without it', async () => {
    revokePermission(HOSPITAL, 'admin', 'invoice:read');
    renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Billing' })).toBeNull();
  });

  it('is unreachable when the hospital has billing switched off', async () => {
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('shows another hospital none of the first one’s invoices', async () => {
    await issueOne();
    for (const permission of ['invoice:read']) grantPermission(CLINIC, 'doctor', permission);
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('heading', LIST_HEADING)).toBeInTheDocument();
    expect(await screen.findByText('No invoices yet.')).toBeInTheDocument();
    expect(screen.queryByText('INV-0001')).toBeNull();
  });
});

describe('printing an invoice', () => {
  it('records the print, then opens the print dialog, once per press', async () => {
    const id = await issueOne();
    renderApp({ entry: `/billing/invoices/${id}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Print invoice' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(mockPrints()).toEqual([{ tenantId: HOSPITAL, invoiceId: id }]);

    const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
    expect(sheet).not.toBeNull();
    expect(within(sheet as HTMLElement).getByText('Invoice INV-0001')).toBeInTheDocument();
    expect(within(sheet as HTMLElement).getByText('Balance due')).toBeInTheDocument();
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Print invoice' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    expect(mockPrints()).toHaveLength(2);
  });

  it('offers no print without invoice:print', async () => {
    const id = await issueOne();
    revokePermission(HOSPITAL, 'admin', 'invoice:print');
    renderApp({ entry: `/billing/invoices/${id}` });
    await screen.findByText(/^Invoice INV-0001 was issued/);
    expect(screen.queryByRole('button', { name: 'Print invoice' })).toBeNull();
  });

  it('offers no print on a draft', async () => {
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    expect(screen.queryByRole('button', { name: 'Print invoice' })).toBeNull();
    expect(print).not.toHaveBeenCalled();
    expect(mockPrints()).toEqual([]);
  });
});
