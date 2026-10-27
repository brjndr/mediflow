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
import { mockDrug } from '@/mocks/handlers/drugs';
import { mockStock } from '@/mocks/handlers/inventory';
import { mockPurchasing } from '@/mocks/handlers/purchasing';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Purchasing (#103). The mock's hospital has two suppliers (Sunrise Pharma Distributors and
// Medline Surgical Supplies) and orders the store keeper drafted: PO-000001 a draft, PO-000002
// submitted and waiting for approval, PO-000003 approved with nothing received, PO-000004
// cancelled; each of two items, 200 units each. The mock starts signed in as the hospital's admin,
// who may approve. The clinic has purchasing off.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };

const grid = (name: string) => screen.getByRole('table', { name });

async function open(path: string, heading: string | RegExp) {
  renderApp({ entry: path });
  await screen.findByRole('heading', { name: heading, level: 1 });
}

const orderOf = (id: string) => mockPurchasing().orders.find((each) => each.id === id);

describe('purchase orders', () => {
  it('lists the orders, newest first, with their status and total', async () => {
    await open('/purchasing', 'Purchase orders');
    const orders = grid('Purchase orders');
    expect(await within(orders).findByText('PO-000001')).toBeInTheDocument();
    expect(within(orders).getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('4 orders.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Purchase orders' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoAxeViolations(document.body);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Approved');
    await waitFor(() => expect(within(orders).queryByText('PO-000001')).toBeNull());
    expect(within(orders).getByText('PO-000003')).toBeInTheDocument();
  });

  it('drafts an order, then submits it for approval', { timeout: 30_000 }, async () => {
    await open('/purchasing/orders/new', 'New purchase order');
    await screen.findByRole('option', { name: 'Medline Surgical Supplies' });
    // Nothing added: the lines say so and the item search takes focus.
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /^Supplier/ }),
      'Medline Surgical Supplies',
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /^Deliver to/ }),
      'Main store',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Add at least one item.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add an item' })).toHaveFocus();

    await userEvent.type(screen.getByRole('combobox', { name: 'Add an item' }), 'gloves');
    await userEvent.click(await screen.findByRole('option', { name: /^Examination gloves/ }));
    const units = screen.getByLabelText(/^Units of Examination gloves/);
    expect(units).toHaveFocus();
    await userEvent.type(units, '500');
    await userEvent.type(
      screen.getByLabelText(/^Price of one unit of Examination gloves/),
      '12,50',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Enter an amount, such as 12.50.')).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
    const price = screen.getByLabelText(/^Price of one unit of Examination gloves/);
    await userEvent.clear(price);
    await userEvent.type(price, '12.50');
    expect(screen.getByText(/Total before tax: .*6,250/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await screen.findByRole('heading', { name: 'Purchase order PO-000005', level: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('Draft saved.');
    const drafted = mockPurchasing().orders.at(-1);
    expect(drafted).toMatchObject({ status: 'draft', totalMinor: 625_000 });
    expect(drafted?.lines).toMatchObject([{ quantity: 500, unitCostMinor: 1250 }]);

    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('PO-000005 submitted for approval.'),
    );
    expect(screen.getByRole('status')).toHaveFocus();
    expect(mockPurchasing().orders.at(-1)?.status).toBe('submitted');
  });

  it('is never approved by who submitted it', async () => {
    signIn(USER_IDS.storeKeeper, HOSPITAL);
    await open('/purchasing/orders/po_h_submitted', 'Purchase order PO-000002');
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveAccessibleDescription(
      'You drafted, changed or submitted this order, so someone else approves it.',
    );
    await userEvent.click(approve);
    expect(orderOf('po_h_submitted')?.status).toBe('submitted');
  });

  it('is approved by the admin when the store keeper submitted it', async () => {
    await open('/purchasing/orders/po_h_submitted', 'Purchase order PO-000002');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('PO-000002 approved.'),
    );
    expect(orderOf('po_h_submitted')).toMatchObject({
      status: 'approved',
      approvedByName: 'Sample Admin',
    });
    expect(screen.getByRole('button', { name: 'Receive goods' })).toBeInTheDocument();
  });

  it('cancels an order with a note saying why', async () => {
    await open('/purchasing/orders/po_h_draft', 'Purchase order PO-000001');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    const panel = await screen.findByRole('region', { name: 'Cancel PO-000001' });
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();
    await userEvent.click(within(panel).getByRole('button', { name: 'Cancel order' }));
    expect(await within(panel).findByText('Say why.')).toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText(/^Why/), 'Ordered by mistake');
    await userEvent.click(within(panel).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('PO-000001 cancelled.'),
    );
    expect(orderOf('po_h_draft')).toMatchObject({
      status: 'cancelled',
      endNote: 'Ordered by mistake',
    });
  });
});

describe('goods receipts', () => {
  it(
    'receives a batch into stock through the ledger, then sends some back',
    { timeout: 30_000 },
    async () => {
      const ledger = mockStock().ledger.length;
      await open('/purchasing/orders/po_h_approved', 'Purchase order PO-000003');
      await userEvent.click(screen.getByRole('button', { name: 'Receive goods' }));
      const panel = await screen.findByRole('region', { name: 'Receive goods against PO-000003' });
      expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();

      // Each row starts with what its line still waits for: a batch number and expiry are needed.
      await userEvent.click(within(panel).getByRole('button', { name: 'Receive goods' }));
      const numbers = within(panel).getAllByLabelText(/^Batch number of/);
      await waitFor(() => expect(numbers[0]).toHaveFocus());
      await expectNoAxeViolations(document.body);

      await userEvent.type(numbers[0] as HTMLElement, 'RX-101');
      await userEvent.type(
        within(panel).getAllByLabelText(/^Expiry date of/)[0] as HTMLElement,
        '2030-06-30',
      );
      // The second item did not come.
      await userEvent.clear(within(panel).getAllByLabelText(/^Units of/)[1] as HTMLElement);
      await userEvent.type(within(panel).getByLabelText(/^Supplier’s invoice/), 'SPD/77');
      await userEvent.click(within(panel).getByRole('button', { name: 'Receive goods' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          'GRN-000001 received. The batches are in stock.',
        ),
      );
      expect(orderOf('po_h_approved')?.status).toBe('partly_received');
      expect(mockStock().ledger).toHaveLength(ledger + 1);
      expect(mockStock().ledger.at(-1)).toMatchObject({
        quantity: 200,
        reason: 'receipt',
        source: 'receipt',
        batchNumber: 'RX-101',
        actorName: 'Sample Admin',
      });

      // The receipt, and units of it sent back to the supplier.
      await userEvent.click(
        await within(grid('Goods received')).findByRole('button', { name: /^Open/ }),
      );
      await screen.findByRole('heading', { name: 'Goods receipt GRN-000001', level: 1 });
      await userEvent.click(screen.getByRole('button', { name: 'Return to supplier' }));
      const back = await screen.findByRole('region', {
        name: 'Return to Sunrise Pharma Distributors',
      });
      await userEvent.type(within(back).getByLabelText(/^Units of .*RX-101/), '250');
      await userEvent.click(within(back).getByRole('button', { name: 'Return to supplier' }));
      expect(
        await within(back).findByText('More than the receipt brought in and kept.'),
      ).toBeInTheDocument();
      const units = within(back).getByLabelText(/^Units of .*RX-101/);
      await userEvent.clear(units);
      await userEvent.type(units, '20');
      await userEvent.click(within(back).getByRole('button', { name: 'Return to supplier' }));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('PRN-000001 recorded.'),
      );
      expect(mockStock().ledger.at(-1)).toMatchObject({
        quantity: -20,
        reason: 'purchase_return',
      });
      expect(mockPurchasing().receipts[0]?.lines[0]?.returnedQuantity).toBe(20);
    },
  );

  it('refuses an expired batch on the form', async () => {
    await open('/purchasing/orders/po_h_approved', 'Purchase order PO-000003');
    await userEvent.click(screen.getByRole('button', { name: 'Receive goods' }));
    const panel = await screen.findByRole('region', { name: 'Receive goods against PO-000003' });
    await userEvent.type(
      within(panel).getAllByLabelText(/^Batch number of/)[0] as HTMLElement,
      'OLD-1',
    );
    await userEvent.type(
      within(panel).getAllByLabelText(/^Expiry date of/)[0] as HTMLElement,
      '2020-01-31',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Receive goods' }));
    expect(
      await within(panel).findByText('This batch has expired: it cannot be received.'),
    ).toBeInTheDocument();
    expect(mockPurchasing().receipts).toHaveLength(0);
  });
});

describe('changing a draft that someone else saved meanwhile', () => {
  it(
    'keeps what was typed, takes what they saved in the other fields, and saves again',
    { timeout: 30_000 },
    async () => {
      await open('/purchasing/orders/po_h_draft/edit', 'Edit purchase order PO-000001');
      const units = screen.getAllByLabelText(/^Units of/)[0] as HTMLElement;
      await userEvent.clear(units);
      await userEvent.type(units, '350');
      // Someone else saves the draft with a note before this person does.
      const order = orderOf('po_h_draft');
      if (!order) throw new Error('no draft');
      order.note = 'Urgent before month end';
      order.version += 1;

      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(await screen.findByText(/Someone saved this order meanwhile/)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByLabelText(/^Note/)).toHaveValue('Urgent before month end'),
      );
      expect(screen.getAllByLabelText(/^Units of/)[0]).toHaveValue('350');

      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await screen.findByRole('heading', { name: 'Purchase order PO-000001', level: 1 });
      expect(orderOf('po_h_draft')).toMatchObject({ note: 'Urgent before month end', version: 3 });
      expect(orderOf('po_h_draft')?.lines[0]?.quantity).toBe(350);
    },
  );
});

describe('receiving, checked', () => {
  it('refuses more than the order waits for, and a cost above the agreed price, on the form', async () => {
    await open('/purchasing/orders/po_h_approved', 'Purchase order PO-000003');
    await userEvent.click(screen.getByRole('button', { name: 'Receive goods' }));
    const panel = await screen.findByRole('region', { name: 'Receive goods against PO-000003' });
    await userEvent.type(
      within(panel).getAllByLabelText(/^Batch number of/)[0] as HTMLElement,
      'Q-1',
    );
    await userEvent.type(
      within(panel).getAllByLabelText(/^Expiry date of/)[0] as HTMLElement,
      '2030-06-30',
    );
    const units = within(panel).getAllByLabelText(/^Units of/)[0] as HTMLElement;
    await userEvent.clear(units);
    await userEvent.type(units, '201');
    const cost = within(panel).getAllByLabelText(/^Cost of one unit of/)[0] as HTMLElement;
    await userEvent.clear(cost);
    await userEvent.type(cost, '99.00');
    await userEvent.clear(within(panel).getAllByLabelText(/^Units of/)[1] as HTMLElement);
    await userEvent.click(within(panel).getByRole('button', { name: 'Receive goods' }));
    expect(
      await within(panel).findByText('More than the order still waits for.'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('More than the agreed price. A dearer delivery needs a new order.'),
    ).toBeInTheDocument();
    expect(mockPurchasing().receipts).toHaveLength(0);
  });

  it('says so when the server refuses, and keeps the form open', async () => {
    const order = orderOf('po_h_approved');
    const item = mockDrug(HOSPITAL, order?.lines[0]?.drugId ?? '');
    if (!item) throw new Error('no item');
    item.archived = true;
    await open('/purchasing/orders/po_h_approved', 'Purchase order PO-000003');
    await userEvent.click(screen.getByRole('button', { name: 'Receive goods' }));
    const panel = await screen.findByRole('region', { name: 'Receive goods against PO-000003' });
    await userEvent.type(
      within(panel).getAllByLabelText(/^Batch number of/)[0] as HTMLElement,
      'Q-2',
    );
    await userEvent.type(
      within(panel).getAllByLabelText(/^Expiry date of/)[0] as HTMLElement,
      '2030-06-30',
    );
    await userEvent.clear(within(panel).getAllByLabelText(/^Units of/)[1] as HTMLElement);
    await userEvent.click(within(panel).getByRole('button', { name: 'Receive goods' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'An item on the order has been archived since',
    );
    expect(within(panel).getAllByLabelText(/^Batch number of/)[0]).toHaveValue('Q-2');
    item.archived = false;
  });

  it('closes an order partly received when the rest will not come', async () => {
    const order = orderOf('po_h_approved');
    if (!order) throw new Error('no order');
    order.status = 'partly_received';
    const first = order.lines[0];
    if (first) first.receivedQuantity = 50;
    await open('/purchasing/orders/po_h_approved', 'Purchase order PO-000003');
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close order' }));
    const panel = await screen.findByRole('region', { name: 'Close PO-000003' });
    await userEvent.type(within(panel).getByLabelText(/^Why/), 'Discontinued by the maker');
    await userEvent.click(within(panel).getByRole('button', { name: 'Close order' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('PO-000003 closed.'));
    expect(orderOf('po_h_approved')).toMatchObject({
      status: 'closed',
      endNote: 'Discontinued by the maker',
    });
  });
});

describe('suppliers', () => {
  it('adds a supplier, checking its GSTIN', async () => {
    await open('/purchasing/suppliers', 'Suppliers');
    expect(
      await within(grid('Suppliers')).findByText('Sunrise Pharma Distributors'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add a supplier' }));
    const panel = await screen.findByRole('region', { name: 'Add a supplier' });
    await userEvent.type(within(panel).getByLabelText(/^Name/), 'Apex Healthcare');
    await userEvent.type(within(panel).getByLabelText(/^GSTIN/), 'not-a-gstin');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save supplier' }));
    expect(
      await within(panel).findByText(
        'Enter a GSTIN of 15 letters and digits, starting with 2 digits.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText(/^GSTIN/)).toHaveFocus();
    await expectNoAxeViolations(document.body);
    const gstin = within(panel).getByLabelText(/^GSTIN/);
    await userEvent.clear(gstin);
    await userEvent.type(gstin, '29aabca1234b1z9');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save supplier' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Apex Healthcare added.'),
    );
    expect(mockPurchasing().suppliers.at(-1)).toMatchObject({
      name: 'Apex Healthcare',
      gstin: '29AABCA1234B1Z9',
    });
  });

  it('does not archive one with an open order', async () => {
    await open('/purchasing/suppliers', 'Suppliers');
    await userEvent.click(
      await within(grid('Suppliers')).findByRole('button', {
        name: /^Archive.*Sunrise Pharma Distributors/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'This supplier has an order that may still bring goods.',
      ),
    );
  });
});

describe('access', () => {
  it('shows suppliers without changing them to a role that only reads them', async () => {
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'supplier:read' }]);
    await open('/purchasing/suppliers', 'Suppliers');
    await within(grid('Suppliers')).findByText('Sunrise Pharma Distributors');
    expect(screen.queryByRole('button', { name: 'Add a supplier' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Purchase orders' })).toBeNull();
  });

  it('reads orders without acting on them for a role with purchaseOrder:read alone', async () => {
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'purchaseOrder:read' }]);
    await open('/purchasing/orders/po_h_approved', 'Purchase order PO-000003');
    expect(screen.queryByRole('button', { name: 'Receive goods' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    renderApp({ entry: '/purchasing/orders/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is closed without purchaseOrder:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'purchaseOrder:read');
    renderApp({ entry: '/purchasing' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable when the hospital has purchasing switched off', async () => {
    setTenantFeature(HOSPITAL, 'purchasing', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/purchasing' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Purchasing' })).toBeNull();
  });

  it('shows the clinic none of the hospital’s orders', async () => {
    setTenantFeature(CLINIC, 'purchasing', true);
    setRolePermissions(CLINIC, 'doctor', [{ permission: 'purchaseOrder:read' }]);
    signIn(USER_IDS.doctor, CLINIC);
    await open('/purchasing', 'Purchase orders');
    expect(await screen.findByText('No purchase orders.')).toBeInTheDocument();
    renderApp({ entry: '/purchasing/orders/po_h_approved' });
    expect(await screen.findByText('This purchase order does not exist.')).toBeInTheDocument();
  });
});
