import { cleanup, screen, waitFor, within } from '@testing-library/react';
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
import { mockDispenses } from '@/mocks/handlers/pharmacy';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Returns of a dispense (#104). The clinical mock's prescription rx_h_1 has 5 of cetirizine 10 mg,
// which the inventory mock keeps at the pharmacy counter in CTZ25A (50 units). Each test dispenses
// them first, then brings some back to stock and wastes others.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };
const CETIRIZINE = 'Cetirizine 10 mg (CetiCare)';
const RETURN_BUTTON = { name: `Return items of ${CETIRIZINE}` };

async function dispenseCetirizine() {
  renderApp({ entry: '/pharmacy/prescriptions/rx_h_1' });
  const medicines = await screen.findByRole('table', { name: 'Medicines' });
  await userEvent.click(
    await within(medicines).findByRole('button', { name: `Dispense: ${CETIRIZINE}` }),
  );
  const panel = await screen.findByRole('region', { name: `Dispense ${CETIRIZINE}` });
  await within(panel).findByRole('textbox', { name: /^Batch CTZ25A/ });
  await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(`5 units of ${CETIRIZINE} dispensed.`),
  );
}

async function openReturn() {
  await userEvent.click(await screen.findByRole('button', RETURN_BUTTON));
  return screen.findByRole('region', { name: `Return items of ${CETIRIZINE}` });
}

describe('returning a dispense', () => {
  it(
    'brings units back to stock and wastes others, then says so',
    { timeout: 20_000 },
    async () => {
      await dispenseCetirizine();
      const panel = await openReturn();
      expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();
      expect(within(panel).getByText(/Batch CTZ25A, .*: 5 units can be returned/)).toBeVisible();
      await expectNoAxeViolations(document.body);

      const ledger = mockStock().ledger.length;
      await userEvent.type(
        within(panel).getByRole('textbox', { name: 'Units of CTZ25A back to stock' }),
        '2',
      );
      await userEvent.type(
        within(panel).getByRole('textbox', { name: /^Units of CTZ25A wasted/ }),
        '1',
      );
      await userEvent.type(
        within(panel).getByRole('textbox', { name: /^Why they are returned/ }),
        'Rash after the first dose',
      );
      await userEvent.click(within(panel).getByRole('button', { name: 'Record return' }));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          `3 units of ${CETIRIZINE} were returned.`,
        ),
      );
      expect(screen.getByRole('status')).toHaveFocus();
      expect(mockStock().ledger.slice(ledger)).toMatchObject([
        { quantity: 2, reason: 'dispense_return', source: 'dispense_return' },
        { quantity: 1, reason: 'dispense_return', source: 'dispense_return' },
        { quantity: -1, reason: 'wastage', source: 'dispense_return' },
      ]);
      expect(mockDispenses().dispenses[0]?.batches[0]?.returnedQuantity).toBe(3);
      expect(
        await screen.findByText(
          /2 units of CTZ25A back to stock; 1 unit of CTZ25A wasted\. Why: Rash after the first dose/,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/\(3 returned\)/)).toBeInTheDocument();
    },
  );

  it(
    'checks the units and the reason before sending, and closes back to its button',
    { timeout: 20_000 },
    async () => {
      await dispenseCetirizine();
      const panel = await openReturn();
      await userEvent.click(within(panel).getByRole('button', { name: 'Record return' }));
      expect(
        await within(panel).findByText('Enter the units of at least one batch.'),
      ).toBeInTheDocument();
      expect(within(panel).getByText('Say why the items are returned.')).toBeInTheDocument();
      await userEvent.type(
        within(panel).getByRole('textbox', { name: 'Units of CTZ25A back to stock' }),
        '4',
      );
      await userEvent.type(
        within(panel).getByRole('textbox', { name: /^Units of CTZ25A wasted/ }),
        '2',
      );
      await userEvent.click(within(panel).getByRole('button', { name: 'Record return' }));
      expect(
        await within(panel).findByText('More than can be returned of this batch.'),
      ).toBeInTheDocument();
      expect(mockDispenses().dispenses[0]?.returns).toHaveLength(0);

      await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.getByRole('button', RETURN_BUTTON)).toHaveFocus());
    },
  );

  it('is not offered without dispense:return', { timeout: 20_000 }, async () => {
    revokePermission(HOSPITAL, 'admin', 'dispense:return');
    await dispenseCetirizine();
    expect(screen.getByRole('button', { name: `Print slip of ${CETIRIZINE}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', RETURN_BUTTON)).toBeNull();
  });

  it('works for the pharmacist role', { timeout: 20_000 }, async () => {
    signIn(USER_IDS.pharmacist, HOSPITAL);
    await dispenseCetirizine();
    expect(await screen.findByRole('button', RETURN_BUTTON)).toBeInTheDocument();
  });

  it('is closed with the pharmacy switched off', { timeout: 20_000 }, async () => {
    await dispenseCetirizine();
    setTenantFeature(HOSPITAL, 'pharmacy', false);
    cleanup();
    renderApp({ entry: '/pharmacy/prescriptions/rx_h_1' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it(
    'never offers the clinic a return of the hospital’s dispense',
    { timeout: 20_000 },
    async () => {
      await dispenseCetirizine();
      setTenantFeature(CLINIC, 'pharmacy', true);
      setRolePermissions(CLINIC, 'doctor', [
        { permission: 'dispense:read' },
        { permission: 'dispense:return' },
      ]);
      // The hospital's screen is gone before the clinic's is drawn.
      cleanup();
      signIn(USER_IDS.doctor, CLINIC);
      renderApp({ entry: '/pharmacy/prescriptions/rx_h_1' });
      expect(await screen.findByText('This prescription is not available.')).toBeInTheDocument();
      expect(screen.queryByRole('button', RETURN_BUTTON)).toBeNull();
    },
  );
});
