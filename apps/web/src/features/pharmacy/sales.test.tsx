import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import drugsEn from '@/features/drugs/locales/en.json';
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
import { mockSales } from '@/mocks/handlers/pharmacy-sales';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Counter sales and the drug register (#101). At the pharmacy counter the inventory mock has
// cetirizine 10 mg (Schedule none) in CTZ25A (50 units at 2.50) and a Schedule H1 medicine in
// CFX25A (40 units at 18.00). The mock starts signed in as the hospital's admin.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };
const CETIRIZINE = 'drg_h_0805';
const h1Id = () =>
  mockStock().ledger.find((entry) => entry.batchNumber === 'CFX25A')?.item.drugId ?? '';

const grid = (name: string) => screen.getByRole('table', { name });

/** How the drug search names an item of the mock. */
function nameOf(id: string) {
  const drug = mockDrug(HOSPITAL, id);
  if (!drug) throw new Error(`no drug ${id}`);
  const form = drugsEn.forms[drug.form as keyof typeof drugsEn.forms];
  return `${drug.genericName} ${drug.strength} ${form} (${drug.brandName})`;
}

/** Adds an item to the sale through its search. */
async function addItem(id: string) {
  const drug = mockDrug(HOSPITAL, id);
  const name = nameOf(id);
  await userEvent.type(
    screen.getByRole('combobox', { name: 'Add an item' }),
    drug?.brandName ?? '',
  );
  await userEvent.click(await screen.findByRole('option', { name }));
  await screen.findByRole('textbox', { name: `Units of ${name}` });
  return name;
}

async function openNewSale() {
  renderApp({ entry: '/pharmacy/sales/new' });
  await screen.findByRole('heading', { name: 'New counter sale', level: 1 });
  await screen.findByRole('combobox', { name: 'Sell from' });
}

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal('print', print);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a counter sale', () => {
  it(
    'sells an over-the-counter item to a walk-in, nearest expiry first, and opens the sale',
    { timeout: 20_000 },
    async () => {
      await openNewSale();
      const name = await addItem(CETIRIZINE);
      const units = screen.getByRole('textbox', { name: `Units of ${name}` });
      expect(units).toHaveFocus();
      await userEvent.clear(units);
      await userEvent.type(units, '3');
      expect(await screen.findByText(/^3 units from batch CTZ25A/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Patient (optional)' })).toBeInTheDocument();
      await expectNoAxeViolations(document.body);

      const ledger = mockStock().ledger.length;
      await userEvent.click(screen.getByRole('button', { name: 'Record sale' }));
      expect(
        await screen.findByRole('heading', { name: 'Counter sale', level: 1 }),
      ).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Sale recorded.');
      expect(screen.getByText('Walk-in, not named')).toBeInTheDocument();
      expect(mockSales().sales).toHaveLength(1);
      expect(mockSales().sales[0]?.totalMinor).toBe('750');
      expect(mockStock().ledger.slice(ledger)).toMatchObject([
        { quantity: -3, reason: 'sale', source: 'sale' },
      ]);
      await expectNoAxeViolations(document.body);
    },
  );

  it(
    'sells a Schedule H1 item only to a patient against an outside prescription',
    { timeout: 20_000 },
    async () => {
      await openNewSale();
      await addItem(h1Id());
      expect(await screen.findByText(/Sold only against a prescription\./)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Outside prescription' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Record sale' }));
      expect(
        await screen.findByText(
          'Choose the patient: an item of this sale is sold only against a prescription.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /^Patient/ })).toHaveFocus();
      expect(mockSales().sales).toHaveLength(0);

      await userEvent.type(screen.getByRole('combobox', { name: /^Patient/ }), 'MRN-PTH-00001');
      await userEvent.click(await screen.findByRole('option', { name: /MRN-PTH-00001/ }));
      expect(await screen.findByRole('button', { name: 'Change patient' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Record sale' }));
      expect(screen.getByRole('textbox', { name: /^Prescriber’s name/ })).toHaveFocus();
      expect(mockSales().sales).toHaveLength(0);

      await userEvent.type(screen.getByRole('textbox', { name: /^Prescriber’s name/ }), 'Dr Mehta');
      await userEvent.type(
        screen.getByRole('textbox', { name: /^Prescriber’s registration number/ }),
        'MCI-12345',
      );
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await userEvent.type(screen.getByLabelText(/^Prescription date/), yesterday);
      await userEvent.click(screen.getByRole('button', { name: 'Record sale' }));
      expect(
        await screen.findByRole('heading', { name: 'Counter sale', level: 1 }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Dr Mehta \(MCI-12345\)/)).toBeInTheDocument();
      expect(mockSales().sales[0]).toMatchObject({
        patientId: 'pth_00001',
        prescriberRegistration: 'MCI-12345',
      });
    },
  );

  it('returns units to stock, never more than were sold, and prints a receipt', async () => {
    await openNewSale();
    const name = await addItem(CETIRIZINE);
    const units = screen.getByRole('textbox', { name: `Units of ${name}` });
    await userEvent.clear(units);
    await userEvent.type(units, '2');
    await userEvent.click(screen.getByRole('button', { name: 'Record sale' }));
    await screen.findByRole('heading', { name: 'Counter sale', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Return items' }));
    const panel = screen.getByRole('region', { name: 'Return items' });
    expect(within(panel).getByRole('heading', { name: 'Return items' })).toHaveFocus();
    const field = within(panel).getByRole('textbox', { name: /^Units of / });
    await userEvent.type(field, '3');
    await userEvent.type(within(panel).getByRole('textbox', { name: /^Why/ }), 'Not needed');
    await userEvent.click(within(panel).getByRole('button', { name: 'Return to stock' }));
    expect(await within(panel).findByText('More than can be returned of this line.')).toBeVisible();
    await userEvent.clear(field);
    await userEvent.type(field, '1');
    await userEvent.click(within(panel).getByRole('button', { name: 'Return to stock' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('The items were returned to stock.'),
    );
    expect(screen.getByRole('status')).toHaveFocus();
    expect(mockStock().ledger.at(-1)).toMatchObject({ quantity: 1, source: 'sale_return' });
    expect(within(grid('Items sold')).getByText('1 unit')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(mockSales().prints).toHaveLength(1);
    const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
    expect(within(sheet as HTMLElement).getByText('Pharmacy receipt')).toBeInTheDocument();
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());
  });
});

describe('the drug register', () => {
  it('lists every movement of a register item, and says when an item is not kept in it', async () => {
    renderApp({ entry: '/pharmacy/register' });
    await screen.findByRole('heading', { name: 'Drug register', level: 1 });
    // The opening stock was posted 30 days ago, one day before the last 30 the screen opens on.
    const from = screen.getByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10));
    const h1 = mockDrug(HOSPITAL, h1Id());
    await userEvent.type(screen.getByRole('combobox', { name: 'Item' }), h1?.brandName ?? '');
    await userEvent.click(await screen.findByRole('option', { name: nameOf(h1Id()) }));
    expect(await screen.findByText('1 movement.')).toBeInTheDocument();
    expect(within(grid('Drug register')).getByText('Stock adjustment')).toBeInTheDocument();
    expect(within(grid('Drug register')).getByText('40 units in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Change the item/ })).toHaveFocus();
    await expectNoAxeViolations(document.body);

    await userEvent.click(screen.getByRole('button', { name: /^Change the item/ }));
    const ceti = mockDrug(HOSPITAL, CETIRIZINE);
    await userEvent.type(screen.getByRole('combobox', { name: 'Item' }), ceti?.brandName ?? '');
    await userEvent.click(await screen.findByRole('option', { name: nameOf(CETIRIZINE) }));
    expect(
      await screen.findByText('This item is not kept in the drug register.'),
    ).toBeInTheDocument();
  });
});

describe('a prescription on an over-the-counter sale', () => {
  it('asks for the patient it is for before sending', async () => {
    await openNewSale();
    await addItem(CETIRIZINE);
    await userEvent.type(screen.getByRole('textbox', { name: /^Prescriber’s name/ }), 'Dr Rao');
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Prescriber’s registration number/ }),
      'MCI-1',
    );
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await userEvent.type(screen.getByLabelText(/^Prescription date/), yesterday);
    await userEvent.click(screen.getByRole('button', { name: 'Record sale' }));
    expect(
      await screen.findByText(
        'Choose the patient the prescription is for, or leave the prescription empty.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^Patient/ })).toHaveFocus();
    expect(mockSales().sales).toHaveLength(0);
  });
});

describe('access', () => {
  it('shows a sale without Return items to a role that may not return', async () => {
    revokePermission(HOSPITAL, 'admin', 'sale:return');
    await openNewSale();
    await addItem(CETIRIZINE);
    await userEvent.click(screen.getByRole('button', { name: 'Record sale' }));
    await screen.findByRole('heading', { name: 'Counter sale', level: 1 });
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Return items' })).toBeNull();
  });

  it('works for the pharmacist role, with links to each pharmacy screen', async () => {
    signIn(USER_IDS.pharmacist, HOSPITAL);
    renderApp({ entry: '/pharmacy/sales' });
    await screen.findByRole('heading', { name: 'Counter sales', level: 1 });
    const links = screen.getByRole('navigation', { name: 'Pharmacy screens' });
    expect(within(links).getByRole('link', { name: 'Counter sales' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(links).getByRole('link', { name: 'Drug register' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New sale' })).toBeInTheDocument();
    expect(await screen.findByText('No counter sales in this time.')).toBeInTheDocument();
  });

  it('hides selling and the register without their permissions', async () => {
    revokePermission(HOSPITAL, 'admin', 'sale:create');
    revokePermission(HOSPITAL, 'admin', 'drugRegister:read');
    const { unmount } = renderApp({ entry: '/pharmacy/sales' });
    await screen.findByRole('heading', { name: 'Counter sales', level: 1 });
    expect(screen.queryByRole('link', { name: 'New sale' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Drug register' })).toBeNull();
    unmount();
    const again = renderApp({ entry: '/pharmacy/sales/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    again.unmount();
    renderApp({ entry: '/pharmacy/register' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is not reachable with the switch off, and shows the clinic none of the hospital’s sales', async () => {
    setTenantFeature(HOSPITAL, 'pharmacy', false);
    const { unmount } = renderApp({ entry: '/pharmacy/sales' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    unmount();
    setTenantFeature(HOSPITAL, 'pharmacy', true);
    mockSales().sales.push({
      tenantId: HOSPITAL,
      id: 'sal_hospital',
      locationId: 'loc_h_pharmacy',
      locationName: 'Pharmacy counter',
      totalMinor: '250',
      returnedMinor: '0',
      soldAt: new Date().toISOString(),
      soldByName: 'Sample Admin',
      lines: [],
      returns: [],
    });
    setTenantFeature(CLINIC, 'pharmacy', true);
    setRolePermissions(CLINIC, 'doctor', [{ permission: 'sale:read' }]);
    signIn(USER_IDS.doctor, CLINIC);
    const list = renderApp({ entry: '/pharmacy/sales' });
    expect(await screen.findByText('No counter sales in this time.')).toBeInTheDocument();
    list.unmount();
    renderApp({ entry: '/pharmacy/sales/sal_hospital' });
    expect(await screen.findByText('This sale is not available.')).toBeInTheDocument();
  });
});
