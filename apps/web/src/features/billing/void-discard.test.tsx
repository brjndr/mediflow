import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockCharges, mockInvoices, setMockPackage } from '@/mocks/handlers/billing';
import { mockServiceNamed } from '@/mocks/handlers/services';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Voiding a pending charge and discarding a draft (#1240), against the mock. The hospital's open
// consultation enc_h_1 has three pending charges.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NEW = '/billing/new?encounterId=enc_h_1';
const VOID = 'Void charge: Complete blood count';

const charges = () => screen.getByRole('table', { name: 'Pending charges' });
const dialog = () => screen.getByRole('alertdialog');
const bloodCount = () =>
  mockCharges().find((charge) => charge.description === 'Complete blood count');

async function openBuilder() {
  const app = renderApp({ entry: NEW });
  await screen.findByRole('heading', { name: 'New invoice', level: 1 });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
  return app;
}

/** Saves a draft of the visit's charges and stays on its page. */
async function openDraft() {
  const app = await openBuilder();
  await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('button', { name: 'Discard draft' });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
  return app;
}

describe('voiding a charge', () => {
  it('asks for a reason, voids it and keeps the keyboard’s place', async () => {
    await openBuilder();
    await userEvent.click(within(charges()).getByRole('button', { name: VOID }));
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Void charge' }));
    expect(await within(dialog()).findByText('This field is required.')).toBeInTheDocument();
    expect(bloodCount()?.status).toBe('pending');
    await expectNoAxeViolations();

    await userEvent.selectOptions(
      within(dialog()).getByLabelText(/^Reason/),
      'The work was not done',
    );
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Void charge' }));
    const said = await screen.findByText('Complete blood count voided.');
    expect(bloodCount()).toMatchObject({ status: 'void', voidReason: 'not_performed' });
    await waitFor(() => expect(said).toHaveFocus());
    expect(within(charges()).queryByText('Complete blood count')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('₹551.00');
  });

  it('warns before voiding a package that covers other charges, and wants a tick', async () => {
    const idOf = (name: string) => mockServiceNamed(HOSPITAL, name)?.id ?? '';
    setMockPackage(HOSPITAL, idOf('Basic health check'), [
      { serviceId: idOf('Wound dressing'), kind: 'included' },
    ]);
    await openBuilder();
    await userEvent.type(screen.getByRole('combobox', { name: 'Service' }), 'Wound dressing');
    await userEvent.click(await screen.findByRole('option', { name: /Wound dressing/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    await within(charges()).findByText('Wound dressing');
    await userEvent.type(screen.getByRole('combobox', { name: 'Package' }), 'Basic health check');
    await userEvent.click(await screen.findByRole('option', { name: /Basic health check/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply package' }));
    await within(charges()).findByText('Basic health check');
    const applied = () =>
      mockCharges().find((charge) => charge.description === 'Basic health check');

    await userEvent.click(
      within(charges()).getByRole('button', { name: 'Void charge: Basic health check' }),
    );
    await userEvent.selectOptions(within(dialog()).getByLabelText(/^Reason/), 'Another reason');
    const confirm = within(dialog()).getByRole('button', { name: 'Void charge' });
    await userEvent.click(confirm);
    expect(
      await within(dialog()).findByText(/^This package covers other charges/),
    ).toBeInTheDocument();
    await userEvent.click(confirm);
    expect(
      await within(dialog()).findByText(/^Tick the box to void a package/),
    ).toBeInTheDocument();
    expect(applied()?.status).toBe('pending');
    await expectNoAxeViolations();

    await userEvent.click(within(dialog()).getByRole('checkbox'));
    await userEvent.click(confirm);
    await screen.findByText('Basic health check voided.');
    expect(applied()?.status).toBe('void');
    expect(mockCharges().find((c) => c.description === 'Wound dressing')?.status).toBe('void');
  });

  it('is not offered without charge:void', async () => {
    revokePermission(HOSPITAL, 'admin', 'charge:void');
    await openBuilder();
    expect(screen.queryByRole('button', { name: VOID })).not.toBeInTheDocument();
  });

  it('does not apply to a charge on a saved draft, and says what to do', async () => {
    await openDraft();
    expect(within(charges()).getByRole('button', { name: VOID })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText(/^To void a charge on a saved draft/)).toBeInTheDocument();
  });
});

describe('discarding a draft', () => {
  it('asks for a reason, then shows the draft as discarded, here and in the list', async () => {
    const app = await openDraft();
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Discard draft' }));
    expect(await within(dialog()).findByText('This field is required.')).toBeInTheDocument();
    await expectNoAxeViolations();
    await userEvent.selectOptions(within(dialog()).getByLabelText(/^Reason/), 'Made by mistake');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Discard draft' }));

    const said = await screen.findByText(/^This draft was discarded on .*Reason: Made by mistake/);
    await waitFor(() => expect(said).toHaveFocus());
    expect(screen.getByText('Discarded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payments' })).not.toBeInTheDocument();
    expect(mockInvoices().at(-1)).toMatchObject({ status: 'void' });
    expect(mockCharges().every((charge) => charge.invoiceId === undefined)).toBe(true);
    await expectNoAxeViolations();

    app.unmount();
    renderApp({ entry: '/billing/invoices' });
    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(await within(table).findByText('Discarded draft')).toBeInTheDocument();
    expect(within(table).getByText('Discarded')).toBeInTheDocument();
  });

  it('is not offered without invoice:discard', async () => {
    revokePermission(HOSPITAL, 'admin', 'invoice:discard');
    const app = await openBuilder();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('heading', { name: 'Invoice', level: 1 });
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    app.unmount();
  });

  it('is offered to a custom role that may only read and discard', async () => {
    await openDraft();
    const draftId = mockInvoices().at(-1)?.id ?? '';
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'invoice:read' },
      { permission: 'invoice:discard' },
    ]);
    renderApp({ entry: `/billing/invoices/${draftId}` });
    expect(await screen.findAllByRole('button', { name: 'Discard draft' })).not.toHaveLength(0);
  });

  it('has no way in with billing off', async () => {
    const app = await openDraft();
    const draftId = mockInvoices().at(-1)?.id ?? '';
    app.unmount();
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: `/billing/invoices/${draftId}` });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
  });

  it('is not found from another hospital', async () => {
    const app = await openDraft();
    const draftId = mockInvoices().at(-1)?.id ?? '';
    app.unmount();
    grantPermission(CLINIC, 'receptionist', 'invoice:read');
    grantPermission(CLINIC, 'receptionist', 'invoice:discard');
    signIn(USER_IDS.receptionist);
    renderApp({ entry: `/billing/invoices/${draftId}` });
    expect(await screen.findByText('This invoice is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    expect(mockInvoices().at(-1)).toMatchObject({ status: 'draft' });
  });
});
