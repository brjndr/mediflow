import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockOrdersOf, moveMockOrder } from '@/mocks/handlers/clinical';
import { mockStock } from '@/mocks/handlers/inventory';
import { mockDispenses } from '@/mocks/handlers/pharmacy';
import { editMockAllergies } from '@/mocks/handlers/triage';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The pharmacy (#100). The clinical mock's hospital has one prescription, rx_h_1 of pth_00001
// (penicillin allergy): 6 of paracetamol 500 mg (ParaCare) and 5 of cetirizine 10 mg. At the
// pharmacy counter the inventory mock has paracetamol in PCM24A (4 units, expiring sooner),
// PCM25B (100) and PCM23X (expired, never offered), another brand ParaMed in PMD25C (30), and
// cetirizine in CTZ25A (50). The mock starts signed in as the hospital's admin.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NO_ACCESS = { name: 'You do not have access to this page' };
const PARACETAMOL = 'Paracetamol 500 mg (ParaCare)';

const grid = (name: string) => screen.getByRole('table', { name });

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal('print', print);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function openPrescription() {
  renderApp({ entry: '/pharmacy/prescriptions/rx_h_1' });
  await screen.findByRole('heading', { name: 'Dispense prescription', level: 1 });
  await within(grid('Medicines')).findByText(PARACETAMOL);
}

async function openPanel(item = PARACETAMOL) {
  await userEvent.click(
    await within(grid('Medicines')).findByRole('button', { name: `Dispense: ${item}` }),
  );
  const panel = await screen.findByRole('region', { name: `Dispense ${item}` });
  await within(panel).findByRole('combobox', { name: /^Give/ });
  return panel;
}

const batchField = (panel: HTMLElement, number: string) =>
  within(panel).getByRole('textbox', { name: new RegExp(`^Batch ${number}`) });

describe('the queue', () => {
  it('lists the prescription to dispense and opens it', async () => {
    renderApp({ entry: '/pharmacy' });
    await screen.findByRole('heading', { name: 'Pharmacy', level: 1 });
    const row = await within(grid('Pharmacy')).findByText('2 of 2 to dispense');
    expect(row).toBeInTheDocument();
    expect(within(grid('Pharmacy')).getByText('Not started')).toBeInTheDocument();
    expect(await screen.findByText('1 prescription.')).toBeInTheDocument();
    await expectNoAxeViolations(document.body);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Dispensed');
    expect(await screen.findByText('Nothing was dispensed in this time.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'To dispense');
    await userEvent.click(
      await within(grid('Pharmacy')).findByRole('button', { name: /^Dispense: / }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Dispense prescription', level: 1 }),
    ).toBeInTheDocument();
  });
});

describe('dispensing', () => {
  it(
    'gives the line in full from the batches nearest expiry, never an expired one',
    { timeout: 20_000 },
    async () => {
      await openPrescription();
      expect(screen.getByRole('combobox', { name: 'Dispense from' })).toHaveValue('loc_h_pharmacy');
      expect(screen.getByText('Penicillin')).toBeInTheDocument();
      const panel = await openPanel();
      expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();
      // Nearest expiry first: the 4 of PCM24A, then 2 of PCM25B; the expired batch is not offered.
      expect(batchField(panel, 'PCM24A')).toHaveValue('4');
      expect(batchField(panel, 'PCM25B')).toHaveValue('2');
      expect(within(panel).queryByRole('textbox', { name: /PCM23X/ })).toBeNull();
      await expectNoAxeViolations(document.body);

      const ledger = mockStock().ledger.length;
      await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          `6 units of ${PARACETAMOL} dispensed.`,
        ),
      );
      expect(screen.getByRole('status')).toHaveFocus();
      expect(mockDispenses().dispenses).toHaveLength(1);
      expect(mockDispenses().dispenses[0]?.batches.map((each) => each.quantity)).toEqual([4, 2]);
      expect(mockStock().ledger.slice(ledger)).toMatchObject([
        { quantity: -4, reason: 'dispense', source: 'dispense' },
        { quantity: -2, reason: 'dispense', source: 'dispense' },
      ]);
      expect(mockOrdersOf('enc_h_1').find((each) => each.id === 'ord_h_1')?.status).toBe(
        'completed',
      );
      const rows = within(grid('Medicines')).getAllByRole('row');
      expect(rows.some((row) => /Paracetamol.*Dispensed/.test(row.textContent ?? ''))).toBe(true);
      expect(
        within(grid('Medicines')).getByRole('button', { name: `Dispense: ${PARACETAMOL}` }),
      ).toHaveAttribute('aria-disabled', 'true');
    },
  );

  it(
    'warns of a matching allergy and asks once before dispensing',
    { timeout: 20_000 },
    async () => {
      editMockAllergies(HOSPITAL, 'pth_00001', [{ substance: 'Paracetamol', severity: 'severe' }]);
      await openPrescription();
      const panel = await openPanel();
      expect(
        within(panel).getByText(
          `${PARACETAMOL} matches the patient’s recorded allergy: Paracetamol.`,
        ),
      ).toBeInTheDocument();
      await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
      const ask = await within(panel).findByRole('heading', {
        name: 'Dispense with this allergy warning?',
      });
      expect(ask).toHaveFocus();
      await userEvent.click(within(panel).getByRole('button', { name: 'Review' }));
      expect(mockDispenses().dispenses).toHaveLength(0);
      await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
      await userEvent.click(await within(panel).findByRole('button', { name: 'Dispense anyway' }));
      await waitFor(() => expect(mockDispenses().dispenses).toHaveLength(1));
    },
  );

  it(
    'gives a generic substitute in part with a reason, then completes the line',
    { timeout: 20_000 },
    async () => {
      await openPrescription();
      const panel = await openPanel();
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Give/ }),
        within(panel).getByRole('option', { name: /ParaMed\), generic substitute/ }),
      );
      expect(batchField(panel, 'PMD25C')).toHaveValue('6');
      await userEvent.clear(batchField(panel, 'PMD25C'));
      await userEvent.type(batchField(panel, 'PMD25C'), '2');
      await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
      expect(await within(panel).findByText('Say why a substitute is given.')).toBeInTheDocument();
      expect(within(panel).getByRole('textbox', { name: /^Why a substitute/ })).toHaveFocus();
      await userEvent.type(
        within(panel).getByRole('textbox', { name: /^Why a substitute/ }),
        'ParaCare short',
      );
      await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(/2 units of Paracetamol .*ParaMed/),
      );
      expect(mockDispenses().dispenses[0]).toMatchObject({
        drugId: 'drg_h_2574',
        prescribedDrugId: 'drg_h_2573',
        substitutionReason: 'ParaCare short',
      });
      expect(screen.getByText('Generic substitute: ParaCare short')).toBeInTheDocument();

      await userEvent.click(
        await within(grid('Medicines')).findByRole('button', {
          name: `Mark complete: ${PARACETAMOL}`,
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(`${PARACETAMOL} marked complete`),
      );
      expect(mockOrdersOf('enc_h_1').find((each) => each.id === 'ord_h_1')?.status).toBe(
        'completed',
      );
    },
  );

  it('refuses nothing to give and more than is left', { timeout: 20_000 }, async () => {
    await openPrescription();
    const panel = await openPanel();
    await userEvent.clear(batchField(panel, 'PCM24A'));
    await userEvent.clear(batchField(panel, 'PCM25B'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
    expect(await within(panel).findByText('Give at least one unit.')).toBeInTheDocument();
    await userEvent.type(batchField(panel, 'PCM25B'), '7');
    // What is left is checked over every batch, as the form is sent.
    await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
    expect(
      await within(panel).findByText('That is more than is left of the prescribed quantity.'),
    ).toBeInTheDocument();
    await userEvent.clear(batchField(panel, 'PCM25B'));
    await userEvent.type(batchField(panel, 'PCM24A'), '5');
    expect(
      await within(panel).findByText('This batch has fewer units here than that.'),
    ).toBeInTheDocument();
    expect(mockDispenses().dispenses).toHaveLength(0);
  });

  it(
    'says a refusal in the panel and sends nothing more after it',
    { timeout: 20_000 },
    async () => {
      await openPrescription();
      const panel = await openPanel();
      // Another counter moves the line on behind the screen.
      moveMockOrder('ord_h_1', 'accepted');
      await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
      const alert = await within(panel).findByRole('alert');
      expect(alert).toHaveTextContent('This line changed meanwhile');
      expect(alert).toHaveFocus();
      expect(within(panel).queryByRole('button', { name: 'Dispense' })).toBeNull();
      expect(mockDispenses().dispenses).toHaveLength(0);
      await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    },
  );

  it('records the slip as printed, then prints it', { timeout: 20_000 }, async () => {
    await openPrescription();
    const panel = await openPanel('Cetirizine 10 mg (CetiCare)');
    await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Print slip of Cetirizine 10 mg (CetiCare)',
      }),
    );
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(mockDispenses().prints).toHaveLength(1);
    const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
    expect(sheet).not.toBeNull();
    expect(within(sheet as HTMLElement).getByText('Dispense slip')).toBeInTheDocument();
    expect(
      within(sheet as HTMLElement).getByText(/Batch CTZ25A, expires .*: 5 units/),
    ).toBeInTheDocument();
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());
  });
});

describe('access', () => {
  it('lets a role that only reads see the prescription but not dispense', async () => {
    revokePermission(HOSPITAL, 'admin', 'dispense:create');
    await openPrescription();
    expect(
      within(grid('Medicines')).queryByRole('button', { name: `Dispense: ${PARACETAMOL}` }),
    ).toBeNull();
  });

  it('works for the pharmacist role', async () => {
    signIn(USER_IDS.pharmacist, HOSPITAL);
    await openPrescription();
    expect(screen.getByText('Penicillin')).toBeInTheDocument();
    expect(
      within(grid('Medicines')).getByRole('button', { name: `Dispense: ${PARACETAMOL}` }),
    ).toBeInTheDocument();
  });

  it('says when the allergies cannot be read, and asks before dispensing', async () => {
    revokePermission(HOSPITAL, 'admin', 'allergy:read');
    await openPrescription();
    expect(
      screen.getAllByText('The patient’s allergies cannot be read here, so they are not checked.')
        .length,
    ).toBeGreaterThan(0);
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'Dispense' }));
    expect(
      await within(panel).findByRole('heading', { name: 'Dispense without an allergy check?' }),
    ).toBeInTheDocument();
  });

  it('is not reachable without dispense:read or with the switch off', async () => {
    revokePermission(HOSPITAL, 'admin', 'dispense:read');
    const { unmount } = renderApp({ entry: '/pharmacy' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    unmount();
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'dispense:read' }]);
    setTenantFeature(HOSPITAL, 'pharmacy', false);
    renderApp({ entry: '/pharmacy' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('shows the clinic none of the hospital’s prescriptions', async () => {
    setTenantFeature(CLINIC, 'pharmacy', true);
    setRolePermissions(CLINIC, 'doctor', [{ permission: 'dispense:read' }]);
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/pharmacy' });
    expect(
      await screen.findByText('No prescription is waiting to be dispensed.'),
    ).toBeInTheDocument();
    renderApp({ entry: '/pharmacy/prescriptions/rx_h_1' });
    expect(await screen.findByText('This prescription is not available.')).toBeInTheDocument();
  });
});
