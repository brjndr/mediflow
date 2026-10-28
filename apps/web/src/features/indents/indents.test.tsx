import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockIndents } from '@/mocks/handlers/indents';
import { mockStock } from '@/mocks/handlers/inventory';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Indents (#105). The mock's hospital has IND-000001, the pharmacist's for the pharmacy counter
// from the main store, two items, waiting for approval, and IND-000002, the admin's for Ward 2
// stock, approved by the store keeper for 40 units of one item, nothing issued. The mock starts
// signed in as the hospital's admin, who approves and issues. The clinic has inventory off.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };

async function open(path: string, heading: string | RegExp) {
  renderApp({ entry: path });
  await screen.findByRole('heading', { name: heading, level: 1 });
}

const indentOf = (id: string) => mockIndents().find((each) => each.id === id);

describe('indents', () => {
  it('lists the indents, newest first, by status', async () => {
    await open('/inventory/indents', 'Indents');
    const list = screen.getByRole('table', { name: 'Indents' });
    expect(await within(list).findByText('IND-000001')).toBeInTheDocument();
    expect(within(list).getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('2 indents')).toBeInTheDocument();
    await expectNoAxeViolations(document.body);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Approved');
    await waitFor(() => expect(within(list).queryByText('IND-000001')).toBeNull());
    expect(within(list).getByText('IND-000002')).toBeInTheDocument();
  });

  it('asks a store for items', { timeout: 30_000 }, async () => {
    await open('/inventory/indents/new', 'New indent');
    await screen.findAllByRole('option', { name: 'Main store' });
    const from = screen.getByRole('combobox', { name: /^Place that asks/ });
    const to = screen.getByRole('combobox', { name: /^Store asked/ });
    await userEvent.selectOptions(from, 'Main store');
    await userEvent.selectOptions(to, 'Main store');
    await userEvent.click(screen.getByRole('button', { name: 'Send indent' }));
    expect(
      await screen.findByText('Choose a store other than the place that asks.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Add at least one item.')).toBeInTheDocument();
    await userEvent.selectOptions(from, 'Ward 2 stock');

    await userEvent.type(screen.getByRole('combobox', { name: 'Add an item' }), 'gloves');
    await userEvent.click(await screen.findByRole('option', { name: /^Examination gloves/ }));
    const units = screen.getByLabelText(/^Units of Examination gloves/);
    expect(units).toHaveFocus();
    await userEvent.type(units, '2.5');
    await userEvent.click(screen.getByRole('button', { name: 'Send indent' }));
    expect(await screen.findByText('Enter whole units.')).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
    await userEvent.clear(units);
    await userEvent.type(units, '200');
    await userEvent.click(screen.getByRole('button', { name: 'Send indent' }));

    await screen.findByRole('heading', { name: 'Indent IND-000003', level: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('Indent sent to the store.');
    expect(mockIndents().at(-1)).toMatchObject({
      status: 'requested',
      fromLocationName: 'Ward 2 stock',
      toLocationName: 'Main store',
      lines: [{ requestedQuantity: 200 }],
    });
  });

  it('is approved for less than asked by someone who did not ask', async () => {
    await open('/inventory/indents/ind_h_requested', 'Indent IND-000001');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const panel = await screen.findByRole('region', { name: 'Approve indent IND-000001' });
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();
    const fields = within(panel).getAllByRole('textbox');
    expect(fields.map((each) => (each as HTMLInputElement).value)).toEqual(['50', '30']);
    await userEvent.clear(fields[0] as HTMLElement);
    await userEvent.type(fields[0] as HTMLElement, '60');
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve' }));
    expect(await within(panel).findByText('No more than was asked.')).toBeInTheDocument();
    await userEvent.clear(fields[0] as HTMLElement);
    await userEvent.type(fields[0] as HTMLElement, '20');
    await userEvent.clear(fields[1] as HTMLElement);
    await userEvent.type(fields[1] as HTMLElement, '0');
    await expectNoAxeViolations(document.body);
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Indent IND-000001 approved.'),
    );
    expect(screen.getByRole('status')).toHaveFocus();
    expect(indentOf('ind_h_requested')).toMatchObject({
      status: 'approved',
      decidedByName: 'Sample Admin',
    });
    expect(indentOf('ind_h_requested')?.lines.map((line) => line.approvedQuantity)).toEqual([
      20, 0,
    ]);
  });

  it('is never decided by whoever asked, who may withdraw it', async () => {
    setRolePermissions(HOSPITAL, 'pharmacist', [
      { permission: 'drug:read' },
      { permission: 'indent:read' },
      { permission: 'indent:create' },
      { permission: 'indent:approve' },
    ]);
    signIn(USER_IDS.pharmacist, HOSPITAL);
    await open('/inventory/indents/ind_h_requested', 'Indent IND-000001');
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveAccessibleDescription(
      'Someone else approves or rejects an indent you asked for.',
    );
    await userEvent.click(approve);
    expect(screen.queryByRole('region', { name: 'Approve indent IND-000001' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Indent IND-000001 withdrawn.'),
    );
    expect(indentOf('ind_h_requested')).toMatchObject({
      status: 'cancelled',
      endedByName: 'Sample Pharmacist',
    });
  });

  it('is issued on a voucher from the batches nearest expiry, through the ledger', async () => {
    await open('/inventory/indents/ind_h_approved', 'Indent IND-000002');
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    const panel = await screen.findByRole('region', { name: 'Issue against indent IND-000002' });
    const fields = within(panel).getAllByRole('textbox', { name: /^Units of/ });
    expect((fields[0] as HTMLInputElement).value).toBe('40');
    await userEvent.clear(fields[0] as HTMLElement);
    await userEvent.type(fields[0] as HTMLElement, '41');
    await userEvent.click(within(panel).getByRole('button', { name: 'Issue' }));
    expect(
      await within(panel).findByText('No more than the item still has to issue.'),
    ).toBeInTheDocument();
    await userEvent.clear(fields[0] as HTMLElement);
    await userEvent.type(fields[0] as HTMLElement, '15');
    await expectNoAxeViolations(document.body);
    await userEvent.click(within(panel).getByRole('button', { name: 'Issue' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Voucher IV-000001 issued against indent IND-000002.',
      ),
    );
    const indent = indentOf('ind_h_approved');
    expect(indent?.status).toBe('partly_issued');
    expect(indent?.lines[0]?.issuedQuantity).toBe(15);
    const entries = mockStock().ledger.filter((entry) => entry.source === 'issue');
    expect(entries.map((entry) => [entry.reason, entry.locationName, entry.quantity])).toEqual([
      ['issue_out', 'Main store', -15],
      ['issue_in', 'Ward 2 stock', 15],
    ]);
    expect(screen.getByRole('button', { name: 'Print voucher IV-000001' })).toBeInTheDocument();
    expect(screen.getByText(/: 15 units$/)).toBeInTheDocument();
  });

  it('says in the panel when the store no longer has the units, and keeps it open', async () => {
    await open('/inventory/indents/ind_h_approved', 'Indent IND-000002');
    server.use(
      http.post('*/api/inventory/indents/:indentId/issues', () =>
        HttpResponse.json(
          { error: { code: 'insufficient_stock', message: 'Fewer units' } },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    const panel = await screen.findByRole('region', { name: 'Issue against indent IND-000002' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Issue' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('A batch has fewer units at the store than that now.');
    // Announced as an alert; focus stays on the button pressed, as in purchasing.
    expect(within(panel).getByRole('button', { name: 'Issue' })).toHaveFocus();
    expect(indentOf('ind_h_approved')?.status).toBe('approved');
  });

  it('is closed short with a note saying why', async () => {
    await open('/inventory/indents/ind_h_approved', 'Indent IND-000002');
    await userEvent.click(screen.getByRole('button', { name: 'Close short' }));
    const panel = await screen.findByRole('region', { name: 'Close indent IND-000002 short' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Close short' }));
    expect(await within(panel).findByText('Say why.')).toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText(/^Why/), 'Ward closed for repairs');
    await userEvent.click(within(panel).getByRole('button', { name: 'Close short' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Indent IND-000002 closed short.'),
    );
    expect(indentOf('ind_h_approved')).toMatchObject({
      status: 'closed',
      endNote: 'Ward closed for repairs',
    });
  });
});

describe('access', () => {
  it('reads indents without acting on them for a role with indent:read alone', async () => {
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'indent:read' }]);
    await open('/inventory/indents', 'Indents');
    expect(screen.queryByRole('link', { name: 'New indent' })).toBeNull();
    await open('/inventory/indents/ind_h_requested', 'Indent IND-000001');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    renderApp({ entry: '/inventory/indents/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is in the navigation for a role that indents without seeing the stock', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'indent:read' },
      { permission: 'indent:create' },
    ]);
    await open('/inventory/indents', 'Indents');
    expect(screen.getAllByRole('link', { name: 'Indents' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull();
  });

  it('is closed without indent:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'indent:read');
    renderApp({ entry: '/inventory/indents' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable when the hospital has inventory switched off', async () => {
    setTenantFeature(HOSPITAL, 'inventory', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/inventory/indents' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Indents' })).toBeNull();
  });

  it('shows the clinic none of the hospital’s indents', async () => {
    setTenantFeature(CLINIC, 'inventory', true);
    setRolePermissions(CLINIC, 'doctor', [{ permission: 'indent:read' }]);
    signIn(USER_IDS.doctor, CLINIC);
    await open('/inventory/indents', 'Indents');
    expect(await screen.findByText('No indents.')).toBeInTheDocument();
    renderApp({ entry: '/inventory/indents/ind_h_approved' });
    expect(await screen.findByText('This indent was not found.')).toBeInTheDocument();
  });
});
