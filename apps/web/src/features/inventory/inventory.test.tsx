import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockStock } from '@/mocks/handlers/inventory';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Inventory (#102). The mock's hospital has a main store and a pharmacy counter with opening
// stock of its first thirty items (batches SB001A, SB001B and on; SB003A and SB003B expire within
// the month; every fifth item is low), and two adjustments the store keeper asked for: 10 units
// of SB002A out as damaged, and 120 units of a new batch NEW001 in as opening stock. The mock
// starts signed in as the hospital's admin, who may approve them. The clinic has inventory off.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };

const grid = (name: string) => screen.getByRole('table', { name });

async function open(path: string, heading: string) {
  renderApp({ entry: path });
  await screen.findByRole('heading', { name: heading, level: 1 });
}

describe('the stock', () => {
  it(
    'lists each item with its batches by place, the low ones and those expiring',
    { timeout: 20_000 },
    async () => {
      await open('/inventory', 'Stock');
      expect(
        await within(grid('Stock')).findByText(/SB001A, expires .*, Main store: 15/),
      ).toBeInTheDocument();
      expect(
        within(grid('Stock')).getByText(/SB003A, expiring .*, Main store: 300/),
      ).toBeInTheDocument();
      expect(within(grid('Stock')).getAllByText('Low').length).toBeGreaterThan(0);
      expect(screen.getByRole('navigation', { name: 'Inventory' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Stock' })).toHaveAttribute('aria-current', 'page');
      await expectNoAxeViolations(document.body);

      // The alert narrows the list on the server.
      await userEvent.click(await screen.findByRole('button', { name: /items? expiring$/ }));
      expect(screen.getByRole('button', { name: /items? expiring$/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(await screen.findByText('1 item.')).toBeInTheDocument();
      expect(within(grid('Stock')).getByText(/SB003A/)).toBeInTheDocument();
    },
  );

  it('shows the stock of one place', { timeout: 20_000 }, async () => {
    await open('/inventory', 'Stock');
    await within(grid('Stock')).findByText(/SB001A/);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Place' }),
      'Pharmacy counter',
    );
    await waitFor(() => expect(within(grid('Stock')).queryByText(/SB001A/)).toBeNull());
    expect(
      within(grid('Stock')).getByText(/SB001B, expires .*, Pharmacy counter: 5/),
    ).toBeInTheDocument();
    expect(
      within(grid('Stock')).getAllByRole('columnheader', { name: 'On hand here' }),
    ).toHaveLength(1);
  });
});

describe('adjustments', () => {
  it('approves one the store keeper asked for, which moves the stock into the ledger', async () => {
    const before = mockStock().ledger.length;
    await open('/inventory/adjustments', 'Stock adjustments');
    const approve = await within(grid('Stock adjustments')).findByRole('button', {
      name: /^Approve: .*10 units, Main store$/,
    });
    await expectNoAxeViolations(document.body);
    await userEvent.click(approve);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /Approved: 10 units of .* at Main store\./,
      ),
    );
    expect(screen.getByRole('status')).toHaveFocus();
    expect(mockStock().ledger).toHaveLength(before + 1);
    expect(mockStock().ledger.at(-1)).toMatchObject({
      quantity: -10,
      balanceAfter: 290,
      reason: 'damaged',
      actorName: 'Sample Admin',
    });
    expect(mockStock().adjustments.find((each) => each.id === 'adj_h_pending_1')?.status).toBe(
      'approved',
    );
  });

  it('never offers the one who asked to approve or reject it', async () => {
    signIn(USER_IDS.storeKeeper, HOSPITAL);
    await open('/inventory/adjustments', 'Stock adjustments');
    const approve = await within(grid('Stock adjustments')).findByRole('button', {
      name: /^Approve: .*10 units, Main store$/,
    });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(approve);
    expect(mockStock().adjustments.find((each) => each.id === 'adj_h_pending_1')?.status).toBe(
      'pending',
    );
    expect(
      within(grid('Stock adjustments')).getByRole('button', {
        name: /^Reject: .*10 units, Main store$/,
      }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it(
    'asks for opening stock of a new batch, which waits for approval',
    { timeout: 20_000 },
    async () => {
      signIn(USER_IDS.storeKeeper, HOSPITAL);
      await open('/inventory/adjustments', 'Stock adjustments');
      await userEvent.click(screen.getByRole('button', { name: 'New adjustment' }));
      const panel = await screen.findByRole('region', { name: 'New stock adjustment' });
      expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();

      // Nothing chosen: each field says what it needs, and focus goes to the first.
      await userEvent.click(within(panel).getByRole('button', { name: 'Ask for approval' }));
      expect(await within(panel).findByText('Choose an item.')).toBeInTheDocument();
      expect(within(panel).getByRole('combobox', { name: 'Item' })).toHaveFocus();
      await expectNoAxeViolations(document.body);

      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Place/ }),
        'Main store',
      );
      await userEvent.type(within(panel).getByRole('combobox', { name: 'Item' }), 'gloves');
      await userEvent.click(
        await within(panel).findByRole('option', { name: /^Examination gloves/ }),
      );
      expect(within(panel).getByRole('button', { name: 'Change' })).toHaveFocus();
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Reason/ }),
        'Opening stock',
      );
      expect(within(panel).getByText('This reason brings stock in.')).toBeInTheDocument();
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Batch/ }),
        'A new batch',
      );
      await userEvent.type(within(panel).getByLabelText(/^Batch number/), 'GL-77');
      await userEvent.type(within(panel).getByLabelText(/^Expiry date/), '2028-03-31');
      await userEvent.type(within(panel).getByLabelText(/^Maximum retail price/), '12,50');
      await userEvent.type(within(panel).getByLabelText(/^Units/), '200');
      await userEvent.click(within(panel).getByRole('button', { name: 'Ask for approval' }));
      // A comma is grouping, never a decimal point.
      expect(await within(panel).findByText('Enter an amount such as 125.50.')).toBeInTheDocument();
      await userEvent.clear(within(panel).getByLabelText(/^Maximum retail price/));
      await userEvent.type(within(panel).getByLabelText(/^Maximum retail price/), '12.50');
      await userEvent.click(within(panel).getByRole('button', { name: 'Ask for approval' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          /Asked for 200 units of Examination gloves.* at Main store\. It waits for approval\./,
        ),
      );
      expect(screen.queryByRole('region', { name: 'New stock adjustment' })).toBeNull();
      const asked = mockStock().adjustments.at(-1);
      expect(asked).toMatchObject({
        batchNumber: 'GL-77',
        expiryDate: '2028-03-31',
        mrpMinor: 1250,
        quantity: 200,
        reason: 'opening',
        status: 'pending',
        requestedByName: 'Sample Store Keeper',
      });
      expect(
        await within(grid('Stock adjustments')).findByText(/New batch GL-77/),
      ).toBeInTheDocument();
    },
  );

  it(
    'takes stock out of a batch, and says when there is not that much',
    { timeout: 20_000 },
    async () => {
      await open('/inventory/adjustments', 'Stock adjustments');
      await userEvent.click(screen.getByRole('button', { name: 'New adjustment' }));
      const panel = await screen.findByRole('region', { name: 'New stock adjustment' });
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Place/ }),
        'Pharmacy counter',
      );
      // The brand of the first items, all of which have stock.
      const brand = mockStock().ledger[0]?.item.brandName ?? '';
      await userEvent.type(within(panel).getByRole('combobox', { name: 'Item' }), brand);
      const found = await within(panel).findByRole('listbox');
      await userEvent.click(within(found).getAllByRole('option')[0] as HTMLElement);
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Reason/ }),
        'Damaged',
      );
      expect(within(panel).getByText('This reason takes stock out.')).toBeInTheDocument();
      const batch = within(panel).getByRole('combobox', { name: /^Batch/ });
      await waitFor(() => expect(within(batch).getAllByRole('option').length).toBeGreaterThan(1));
      // A new batch is offered for opening stock only.
      expect(within(batch).queryByRole('option', { name: 'A new batch' })).toBeNull();
      await userEvent.selectOptions(
        batch,
        within(batch).getAllByRole('option')[1] as HTMLOptionElement,
      );
      await userEvent.type(within(panel).getByLabelText(/^Units/), '999999');
      await userEvent.click(within(panel).getByRole('button', { name: 'Ask for approval' }));
      const alert = await within(panel).findByRole('alert');
      expect(alert).toHaveTextContent('The batch has fewer units at that place than that.');
      // Announced; focus stays on the button, to send again once the number is changed.
      expect(within(panel).getByRole('button', { name: 'Ask for approval' })).toHaveFocus();
    },
  );

  it('rejects one with a note saying why', async () => {
    await open('/inventory/adjustments', 'Stock adjustments');
    await userEvent.click(
      await within(grid('Stock adjustments')).findByRole('button', {
        name: /^Reject: .*120 units, Main store$/,
      }),
    );
    const panel = await screen.findByRole('region', { name: /^Reject 120 units of/ });
    await userEvent.click(within(panel).getByRole('button', { name: 'Reject' }));
    expect(await within(panel).findByText('Say why it is rejected.')).toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText(/^Why/), 'Not delivered yet');
    await userEvent.click(within(panel).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Rejected: 120 units/),
    );
    expect(mockStock().adjustments.find((each) => each.id === 'adj_h_pending_2')).toMatchObject({
      status: 'rejected',
      rejectionNote: 'Not delivered yet',
    });
  });
});

describe('the ledger and the places', () => {
  it('lists every change newest first', async () => {
    await open('/inventory/ledger', 'Stock ledger');
    // The rows of the loading state come first: wait for the entries themselves.
    expect(
      (await within(grid('Stock ledger')).findAllByText('Opening stock')).length,
    ).toBeGreaterThan(0);
    expect(within(grid('Stock ledger')).getAllByRole('row').length).toBeGreaterThan(2);
    await expectNoAxeViolations(document.body);
  });

  it('adds a place, and refuses to archive one with stock', async () => {
    await open('/inventory/locations', 'Stock places');
    await userEvent.click(screen.getByRole('button', { name: 'Add a place' }));
    const panel = await screen.findByRole('region', { name: 'Add a place' });
    await userEvent.type(within(panel).getByLabelText(/^Name/), 'Ward 4 stock');
    await userEvent.selectOptions(
      within(panel).getByRole('combobox', { name: /^Kind/ }),
      'Ward stock',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Added Ward 4 stock.'),
    );
    expect(await within(grid('Stock places')).findByText('Ward 4 stock')).toBeInTheDocument();

    await userEvent.click(
      within(grid('Stock places')).getByRole('button', { name: 'Archive: Main store' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('A batch has stock at that place.'),
    );
  });

  it('shows places without changing them to a role that only reads stock', async () => {
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'stock:read' }]);
    await open('/inventory/locations', 'Stock places');
    await within(grid('Stock places')).findByText('Main store');
    expect(screen.queryByRole('button', { name: 'Add a place' })).toBeNull();
    expect(within(grid('Stock places')).queryByRole('button', { name: /Archive/ })).toBeNull();
  });
});

describe('access', () => {
  it('reads without adjusting or approving for a role with stock:read alone', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'stock:read' },
      { permission: 'drug:read' },
    ]);
    await open('/inventory/adjustments', 'Stock adjustments');
    await within(grid('Stock adjustments')).findAllByRole('row');
    expect(screen.queryByRole('button', { name: 'New adjustment' })).toBeNull();
    expect(
      within(grid('Stock adjustments')).queryByRole('button', { name: /^Approve/ }),
    ).toBeNull();
  });

  it('is closed without stock:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'stock:read');
    renderApp({ entry: '/inventory' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable when the hospital has inventory switched off', async () => {
    setTenantFeature(HOSPITAL, 'inventory', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/inventory' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull();
  });

  it('shows the clinic its own places and none of the hospital’s stock', async () => {
    setTenantFeature(CLINIC, 'inventory', true);
    setRolePermissions(CLINIC, 'doctor', [{ permission: 'stock:read' }]);
    signIn(USER_IDS.doctor, CLINIC);
    await open('/inventory/locations', 'Stock places');
    expect(await within(grid('Stock places')).findByText('Clinic store')).toBeInTheDocument();
    expect(within(grid('Stock places')).queryByText('Main store')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Stock' }));
    await screen.findByRole('heading', { name: 'Stock', level: 1 });
    expect(await screen.findByText('3 items.')).toBeInTheDocument();
    expect(within(grid('Stock')).getAllByText('No stock')).toHaveLength(3);
  });
});
