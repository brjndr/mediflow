import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setRolePermissions, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { mockInvoices, mockPayments } from '@/mocks/handlers/billing';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The permission matrix of the billing screens (#113): each role's defaults, as the API seeds them
// (`apps/api/src/features/billing/permissions.ts`, the "Billing and payments" row of
// `docs/PRODUCT.md`), and a custom role, on an invoice's page, the list and the builder. The single
// permissions are tested beside each panel; this checks what each role sees as a whole.

const HOSPITAL = TENANT_IDS.hospital;
const NO_ACCESS = { name: 'You do not have access to this page' };

type Grants = Parameters<typeof setRolePermissions>[2];
const grants = (...permissions: string[]): Grants =>
  permissions.map((permission) => ({ permission }));

/** What every role here holds outside the module: the patient, the visit and the catalog. */
const AROUND = ['patient:read', 'encounter:read', 'service:read'];

const ADMIN = [
  'charge:read',
  'charge:create',
  'invoice:read',
  'invoice:create',
  'invoice:issue',
  'invoice:print',
  'invoice:adjust',
  'payment:read',
  'payment:create',
  'payment:refund',
  'creditNote:create',
];
/** The front desk works the bill; refunds, credit notes and typed lines are the admin's. */
const RECEPTIONIST = [
  'charge:read',
  'charge:create',
  'invoice:read',
  'invoice:create',
  'invoice:issue',
  'invoice:print',
  'payment:read',
  'payment:create',
];
/** A doctor sees charges and invoices. */
const DOCTOR = ['charge:read', 'invoice:read'];

interface View {
  paymentList: boolean;
  recordPayment: boolean;
  refund: boolean;
  credits: boolean;
  issueCredit: boolean;
  print: boolean;
}

/** Roles that read an invoice: what each sees on an issued one with a payment taken. */
const READERS: { role: string; permissions: string[]; view: View }[] = [
  {
    role: 'admin',
    permissions: ADMIN,
    view: {
      paymentList: true,
      recordPayment: true,
      refund: true,
      credits: true,
      issueCredit: true,
      print: true,
    },
  },
  {
    role: 'receptionist',
    permissions: RECEPTIONIST,
    view: {
      paymentList: true,
      recordPayment: true,
      refund: false,
      credits: true,
      issueCredit: false,
      print: true,
    },
  },
  {
    role: 'doctor',
    permissions: DOCTOR,
    view: {
      paymentList: false,
      recordPayment: false,
      refund: false,
      credits: true,
      issueCredit: false,
      print: false,
    },
  },
  {
    // A custom role a hospital might make: sees payments and prints, takes none.
    role: 'auditor (custom)',
    permissions: ['invoice:read', 'invoice:print', 'payment:read'],
    view: {
      paymentList: true,
      recordPayment: false,
      refund: false,
      credits: true,
      issueCredit: false,
      print: true,
    },
  },
];

/** No way into billing by default (`docs/PRODUCT.md`: "no"). */
const NON_READERS = ['nurse', 'pharmacist', 'lab_technician', 'radiologist', 'store_keeper'];

afterEach(() => server.events.removeAllListeners());

/** Issues an invoice of the hospital's visit and takes 300.00 of it, as the admin does. */
async function invoiceWithPayment() {
  const app = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
  await screen.findByText('INV-0001');
  app.unmount();
  const id = mockInvoices()[0]?.id ?? '';
  const page = renderApp({ entry: `/billing/invoices/${id}` });
  await screen.findByRole('heading', { name: 'Payments' });
  const field = screen.getByRole('textbox', { name: /^Amount/ });
  await userEvent.clear(field);
  await userEvent.type(field, '300');
  await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
  await waitFor(() => expect(mockPayments()).toHaveLength(1));
  page.unmount();
  return id;
}

const shown = (name: string) => screen.queryByRole('heading', { name, level: 2 }) !== null;
const button = (name: string | RegExp) => screen.queryByRole('button', { name }) !== null;

describe('the billing permission matrix', () => {
  it.each(READERS)(
    'shows the $role what the role holds, and no trace of the rest',
    async ({ permissions, view }) => {
      const id = await invoiceWithPayment();
      const reads: string[] = [];
      server.events.on('request:start', ({ request }) => {
        if (request.method === 'GET') reads.push(new URL(request.url).pathname);
      });
      // The signed-in admin's role stands for each role in turn.
      setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...permissions));
      renderApp({ entry: `/billing/invoices/${id}` });
      await screen.findByText(/^Invoice INV-0001 was issued on /);
      await screen.findByRole('heading', { name: 'Credit notes', level: 2 });
      if (view.paymentList) await screen.findByRole('table', { name: 'Payments' });

      expect({
        paymentList: screen.queryByRole('table', { name: 'Payments' }) !== null,
        recordPayment: button('Record payment'),
        refund: button('Refund payment'),
        credits: shown('Credit notes'),
        issueCredit: button('Issue credit note'),
        print: button('Print invoice'),
      }).toEqual(view);

      // What is hidden is never asked for, so nothing of it reaches the browser.
      expect(reads.some((path) => path.endsWith(`/invoices/${id}/payments`))).toBe(
        view.paymentList,
      );
      await expectNoAxeViolations();
    },
  );

  it.each(READERS)('lists invoices for the $role', async ({ permissions }) => {
    await invoiceWithPayment();
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...permissions));
    renderApp({ entry: '/billing/invoices' });
    await screen.findByRole('heading', { name: 'Invoices', level: 1 });
    const grid = await screen.findByRole('table', { name: 'Invoices' });
    expect(await within(grid).findByRole('link', { name: 'INV-0001' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Billing' })).toBeInTheDocument();
  });

  it('lets the receptionist build and issue a bill, but not type a line', async () => {
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...RECEPTIONIST));
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    await screen.findByRole('table', { name: 'Pending charges' });
    expect(screen.getByRole('button', { name: 'Issue invoice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Charge a service' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Other lines' })).not.toBeInTheDocument();
  });

  it('lets the doctor read the invoices, but not make or charge one', async () => {
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...DOCTOR));
    const builder = renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    builder.unmount();
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', { name: 'Consultation', level: 1 });
    expect(screen.queryByRole('link', { name: 'Create invoice' })).not.toBeInTheDocument();
  });

  it.each(NON_READERS)('gives the %s no way into billing', async () => {
    // Their defaults hold nothing of billing; what they do hold elsewhere is around it.
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND));
    const list = renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Billing' })).not.toBeInTheDocument();
    list.unmount();
    renderApp({ entry: '/billing/invoices/inv_none' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('gives no role anything with the module off', async () => {
    setTenantFeature(HOSPITAL, 'billing', false);
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...ADMIN));
    renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Billing' })).not.toBeInTheDocument(),
    );
  });
});
