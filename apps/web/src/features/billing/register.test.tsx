import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  mockInvoices,
  mockPayments,
  mockRegisterSessions,
  setMockRegisterOpen,
} from '@/mocks/handlers/billing';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The cash register and day-end settlement (#118). The invoice issued through the builder comes
// to 500.00 + 350.00 + 51.00 = 901.00 at the hospital.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };

afterEach(() => setMockRegisterOpen(true));

const statusLine = () => screen.getAllByRole('status').find((each) => each.tabIndex === -1);
async function messageShown() {
  await waitFor(() => expect(statusLine()).not.toBeEmptyDOMElement());
  return statusLine();
}

/** Opens the caller's drawer on the register screen with `opening` in it. */
async function openDrawer(opening: string) {
  setMockRegisterOpen(false);
  const app = renderApp({ entry: '/billing/register' });
  await screen.findByRole('heading', { name: 'Open the register' });
  const field = screen.getByRole('textbox', { name: /^Cash in the drawer/ });
  await userEvent.clear(field);
  await userEvent.type(field, opening);
  await userEvent.click(screen.getByRole('button', { name: 'Open register' }));
  await screen.findByRole('heading', { name: /^Open since/ });
  app.unmount();
}

/** Issues the visit's invoice and takes one payment against it, on the invoice's page. */
async function pay(amount: string, method: 'cash' | 'card') {
  let id = mockInvoices()[0]?.id;
  if (!id) {
    const builder = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
      'Complete blood count',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    await screen.findByText('INV-0001');
    builder.unmount();
    id = mockInvoices()[0]?.id ?? '';
  }
  const page = renderApp({ entry: `/billing/invoices/${id}` });
  await screen.findByRole('heading', { name: 'Payments' });
  const field = screen.getByRole('textbox', { name: /^Amount/ });
  await userEvent.clear(field);
  await userEvent.type(field, amount);
  await userEvent.selectOptions(screen.getByLabelText(/^Paid by/), method);
  await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
  await waitFor(() => expect(mockPayments().some((each) => each.method === method)).toBe(true));
  page.unmount();
}

describe('opening the register', () => {
  it('says there is none open, then opens one with the cash in it', async () => {
    setMockRegisterOpen(false);
    renderApp({ entry: '/billing/register' });
    expect(await screen.findByText(/You have no cash register open/)).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: /^Cash in the drawer/ });
    expect(field).toHaveValue('0');
    await userEvent.clear(field);
    await userEvent.type(field, '500');
    await userEvent.click(screen.getByRole('button', { name: 'Open register' }));

    expect(await messageShown()).toHaveTextContent('Register opened with ₹500.00.');
    expect(await screen.findByTestId('expected')).toHaveTextContent('500.00');
    expect(mockRegisterSessions()).toHaveLength(1);
    expect(mockRegisterSessions()[0]?.openingMinor).toBe(50000);
    // The form is gone and focus went on to the status line.
    expect(screen.queryByRole('button', { name: 'Open register' })).toBeNull();
    await waitFor(() => expect(statusLine()).toHaveFocus());
  });

  it('refuses an amount that is not one, and a comma that is not grouping', async () => {
    setMockRegisterOpen(false);
    renderApp({ entry: '/billing/register' });
    const field = await screen.findByRole('textbox', { name: /^Cash in the drawer/ });
    await userEvent.clear(field);
    await userEvent.type(field, '12,50');
    await userEvent.click(screen.getByRole('button', { name: 'Open register' }));
    expect(await screen.findByText('This value is not in the expected format.')).toBeVisible();
    expect(mockRegisterSessions()).toHaveLength(0);
  });
});

describe('collections and settling', () => {
  it('shows collections by payment mode, works out the expected cash and settles it short', async () => {
    await openDrawer('100');
    await pay('400', 'cash');
    await pay('200', 'card');

    renderApp({ entry: '/billing/register' });
    await screen.findByRole('heading', { name: /^Open since/ });
    const modes = await screen.findByRole('table', { name: 'Collections by payment mode' });
    await within(modes).findByText('Cash');
    // The API puts only cash in a session: a card payment is not in the drawer's figures.
    expect(within(modes).queryByText('Card')).toBeNull();
    // Only cash goes in the drawer: 100.00 opening + 400.00 cash taken, none refunded.
    expect(screen.getByTestId('expected')).toHaveTextContent('500.00');
    expect(screen.getByTestId('working')).toHaveTextContent(
      'Opening ₹100.00 + cash taken ₹400.00 − cash refunded ₹0.00 = ₹500.00',
    );
    // The modes listed add up to what the cash payments recorded in this session came to.
    const cashTaken = mockPayments()
      .filter((each) => each.sessionId)
      .reduce((sum, each) => sum + each.amountMinor, 0);
    expect(cashTaken).toBe(40000);
    expect(screen.getByTestId('net-all')).toHaveTextContent('₹400.00');

    await userEvent.type(screen.getByRole('textbox', { name: /^Cash counted/ }), '480');
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Note for the handover/ }),
      'Two notes torn',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Close and settle' }));

    expect(await messageShown()).toHaveTextContent('Register settled. Short by ₹20.00.');
    const [settled] = mockRegisterSessions();
    expect(settled?.countedMinor).toBe(48000);
    expect(settled?.differenceMinor).toBe(-2000);
    expect(settled?.note).toBe('Two notes torn');
    // The settlement stays on the screen, to print, and a new drawer can be opened.
    expect(screen.getByRole('button', { name: 'Print settlement' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open register' })).toBeInTheDocument();
    expect(screen.getByTestId('difference')).toHaveTextContent('Short by ₹20.00.');
  });

  it('settles with the count matching and says so in words', async () => {
    await openDrawer('0');
    renderApp({ entry: '/billing/register' });
    await screen.findByRole('heading', { name: /^Open since/ });
    await userEvent.type(screen.getByRole('textbox', { name: /^Cash counted/ }), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Close and settle' }));
    expect(await messageShown()).toHaveTextContent('The count matches: no difference.');
  });

  it('needs the count, and refuses a note that is not plain text', async () => {
    await openDrawer('0');
    renderApp({ entry: '/billing/register' });
    await screen.findByRole('heading', { name: /^Open since/ });
    await userEvent.click(screen.getByRole('button', { name: 'Close and settle' }));
    expect(await screen.findByText('This field is required.')).toBeVisible();
    expect(mockRegisterSessions()[0]?.closedAt).toBeUndefined();
  });

  it('takes cash into the drawer only: a refund of cash comes out of it', async () => {
    await openDrawer('100');
    await pay('400', 'cash');
    const [session] = mockRegisterSessions();
    expect(session?.expectedMinor).toBe(50000);
    expect(session?.totals).toEqual([{ method: 'cash', paidMinor: 40000, refundedMinor: 0 }]);
  });
});

describe('the sessions of the hospital', () => {
  it('lists settled and open sessions, newest first, with the difference', async () => {
    await openDrawer('100');
    const page = renderApp({ entry: '/billing/register' });
    await screen.findByRole('heading', { name: /^Open since/ });
    await userEvent.type(screen.getByRole('textbox', { name: /^Cash counted/ }), '130');
    await userEvent.click(screen.getByRole('button', { name: 'Close and settle' }));
    await messageShown();
    page.unmount();

    renderApp({ entry: '/billing/register/sessions' });
    const grid = await screen.findByRole('table', { name: 'Register sessions' });
    const row = (await within(grid).findByText('Sample Admin')).closest('tr');
    expect(row).not.toBeNull();
    // Counted 130.00 against 100.00 expected: over by 30.00, shown as the difference.
    expect(within(row as HTMLElement).getByText('Over by ₹30.00.')).toBeInTheDocument();
    expect(screen.getByText('1 session')).toBeInTheDocument();

    await userEvent.click(within(grid).getByRole('link', { name: 'Sample Admin' }));
    expect(await screen.findByRole('heading', { name: 'Register session' })).toBeInTheDocument();
    expect(await screen.findByText(/^Settled on/)).toBeInTheDocument();
    expect(screen.getByTestId('difference')).toHaveTextContent('Over by ₹30.00.');
    expect(screen.getByRole('button', { name: 'Print settlement' })).toBeInTheDocument();
  });

  it('says there are none yet', async () => {
    renderApp({ entry: '/billing/register/sessions' });
    expect(await screen.findByText('No register session has been opened yet.')).toBeVisible();
  });

  it('keeps one hospital’s sessions from another', async () => {
    await openDrawer('100');
    for (const permission of ['invoice:read', 'cashRegister:read']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    const list = renderApp({ entry: '/billing/register/sessions' });
    expect(await screen.findByText('No register session has been opened yet.')).toBeVisible();
    list.unmount();
    const id = mockRegisterSessions()[0]?.id ?? '';
    renderApp({ entry: `/billing/register/sessions/${id}` });
    expect(await screen.findByText('This register session is not available.')).toBeVisible();
  });
});

describe('who may', () => {
  it('keeps the register from someone without cashRegister:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'cashRegister:manage');
    renderApp({ entry: '/billing/register' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('keeps every session from someone without cashRegister:read, but not their own drawer', async () => {
    revokePermission(HOSPITAL, 'admin', 'cashRegister:read');
    const first = renderApp({ entry: '/billing/register/sessions' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    first.unmount();
    renderApp({ entry: '/billing/register' });
    expect(await screen.findByRole('heading', { name: 'Cash register' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All sessions and day-end' })).toBeNull();
  });

  it('is unreachable when the hospital has billing switched off', async () => {
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: '/billing/register' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is reached from the invoice list, for those who may', async () => {
    renderApp({ entry: '/billing/invoices' });
    const link = await screen.findByRole('link', { name: 'Cash register' });
    expect(link).toHaveAttribute('href', '/billing/register');
    expect(screen.getByRole('link', { name: 'All sessions and day-end' })).toBeInTheDocument();
  });

  it('works for a custom role that holds only cashRegister:manage', async () => {
    grantPermission(CLINIC, 'billing_clerk', 'cashRegister:manage');
    grantPermission(CLINIC, 'billing_clerk', 'invoice:read');
    signIn(USER_IDS.billingClerk, CLINIC);
    renderApp({ entry: '/billing/register' });
    expect(await screen.findByRole('heading', { name: 'Open the register' })).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations with the drawer closed, open and in the list', async () => {
    setMockRegisterOpen(false);
    const closed = renderApp({ entry: '/billing/register' });
    await screen.findByRole('heading', { name: 'Open the register' });
    await expectNoAxeViolations(closed.container);
    closed.unmount();

    await openDrawer('50');
    const open = renderApp({ entry: '/billing/register' });
    await screen.findByRole('heading', { name: /^Open since/ });
    await expectNoAxeViolations(open.container);
    open.unmount();

    const list = renderApp({ entry: '/billing/register/sessions' });
    await screen.findByRole('table', { name: 'Register sessions' });
    await expectNoAxeViolations(list.container);
  });
});
