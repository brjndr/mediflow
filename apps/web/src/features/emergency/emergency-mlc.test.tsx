import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { mockMlcPrints } from '@/mocks/handlers/emergency';
import { renderApp } from '@/test/render';

// ER-0002 is an unidentified arrival (a road accident brought by the police).
const open = async () => {
  renderApp({ entry: '/emergency/er_2' });
  await screen.findByRole('heading', { level: 1, name: /ER-0002/ });
};

const said = (text: string) =>
  screen.queryAllByRole('status').some((one) => one.textContent === text);

const fillAndFlag = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Mark as medico-legal' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: /Injury and history/ }),
    'Hit by a truck, head injury',
  );
  return dialog;
};

describe('medico-legal case', () => {
  it('is flagged with the required fields, shown on the case and on the board', async () => {
    await open();
    expect(await screen.findByText('This case is not marked medico-legal.')).toBeInTheDocument();

    // The account of the injury is required.
    await userEvent.click(screen.getByRole('button', { name: 'Mark as medico-legal' }));
    const first = await screen.findByRole('dialog');
    await userEvent.click(within(first).getByRole('button', { name: 'Save' }));
    expect(await within(first).findAllByText(/required/i)).not.toHaveLength(0);
    await userEvent.click(within(first).getByRole('button', { name: 'Cancel' }));

    const dialog = await fillAndFlag();
    // Naming the police station is required once the police are informed.
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /police have been informed/ }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findAllByText(/required/i)).not.toHaveLength(0);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Police station/ }),
      'Central police station',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(said('ER-0002 is marked medico-legal.')).toBe(true));
    expect(await screen.findByText('Hit by a truck, head injury')).toBeInTheDocument();
    expect(screen.getByText('Informed, Central police station')).toBeInTheDocument();
    expect(screen.getAllByText('Medico-legal').length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  }, 30_000);

  it('keeps a revision as the next one', async () => {
    await open();
    const dialog = await fillAndFlag();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Hit by a truck, head injury');
    await userEvent.click(screen.getByRole('button', { name: 'Revise' }));
    const again = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      within(again).getByRole('combobox', { name: /Category/ }),
      'assault',
    );
    await userEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(said('The medico-legal record of ER-0002 was revised.')).toBe(true));
    expect(await screen.findByText(/revision 2/)).toBeInTheDocument();
  }, 30_000);
});

describe('printing', () => {
  let print: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    print = vi.fn();
    vi.stubGlobal('print', print);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the print, then prints the latest revision on a sheet of its own', async () => {
    await open();
    const dialog = await fillAndFlag();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Hit by a truck, head injury');
    expect(mockMlcPrints()).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(mockMlcPrints()).toMatchObject([
      { tenantId: TENANT_IDS.hospital, caseId: 'er_2', revision: 1 },
    ]);
    const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
    expect(sheet).not.toBeNull();
    expect(within(sheet!).getByText('Medico-legal record, ER-0002')).toBeInTheDocument();
    expect(within(sheet!).getByText('Hit by a truck, head injury')).toBeInTheDocument();
    expect(within(sheet!).getByText(/revision 1. This print is logged/)).toBeInTheDocument();
    // Nothing of the record is in the address.
    expect(window.location.search).toBe('');
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());
  }, 30_000);

  it('offers no print without medicoLegal:read, and prints nothing', async () => {
    await open();
    const dialog = await fillAndFlag();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Hit by a truck, head injury');
    cleanup();
    revokePermission(TENANT_IDS.hospital, 'admin', 'medicoLegal:read');
    renderApp({ entry: '/emergency/er_2' });
    await screen.findByText(/The details are restricted/);
    expect(screen.queryByRole('button', { name: 'Print' })).not.toBeInTheDocument();
    expect(print).not.toHaveBeenCalled();
    expect(mockMlcPrints()).toHaveLength(0);
  }, 30_000);
});

describe('restricted access', () => {
  it('says only that the case is medico-legal without medicoLegal:read', async () => {
    await open();
    const dialog = await fillAndFlag();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Hit by a truck, head injury');
    cleanup();
    revokePermission(TENANT_IDS.hospital, 'admin', 'medicoLegal:read');
    renderApp({ entry: '/emergency/er_2' });
    expect(
      await screen.findByText(/The details are restricted to those with access to them/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Hit by a truck, head injury')).not.toBeInTheDocument();
  }, 30_000);

  it('offers no flagging without medicoLegal:manage', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'medicoLegal:manage');
    await open();
    await screen.findByRole('heading', { name: 'Observation notes' });
    expect(screen.queryByRole('heading', { name: 'Medico-legal record' })).not.toBeInTheDocument();
  });

  it('is gone with the emergency module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'emergency', false);
    renderApp({ entry: '/emergency/er_2' });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Medico-legal record' }),
      ).not.toBeInTheDocument(),
    );
  });
});
