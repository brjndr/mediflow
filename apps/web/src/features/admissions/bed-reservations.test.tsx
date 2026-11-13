import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission } from '@/mocks/db';
import { TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const LIVE = 'Live: changes show within seconds.';
const grid = () => screen.getByRole('table', { name: 'Beds' });
const rowOf = (bed: string) =>
  within(grid())
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === bed) as HTMLElement;

const openBoard = async () => {
  renderApp({ entry: '/beds' });
  await screen.findByRole('heading', { name: 'Bed board', level: 1 });
  await screen.findByText(LIVE);
  await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBeGreaterThan(1));
};

const reserve = async (bed: string, mrn: string) => {
  await userEvent.click(within(rowOf(bed)).getByRole('button', { name: /Reserve bed/ }));
  await userEvent.type(await screen.findByRole('combobox', { name: /^Patient the bed/ }), mrn);
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(mrn) }));
  await userEvent.click(screen.getByRole('button', { name: 'Reserve bed' }));
};

describe('bed reservations', () => {
  it('holds a bed for a patient, shows it on the board and lets it go', async () => {
    await openBoard();
    await reserve('GW-A-05', 'MRN-PTH-00010');
    await waitFor(() =>
      expect(within(rowOf('GW-A-05')).getByText(/Held for .* until /)).toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Bed GW-A-05 is reserved.');
    // Already held: no second hold, and it is not blocked meanwhile.
    expect(within(rowOf('GW-A-05')).getByRole('button', { name: /Reserve bed/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(rowOf('GW-A-05')).getByRole('button', { name: /Block/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expectNoAxeViolations();

    await userEvent.click(
      within(rowOf('GW-A-05')).getByRole('button', { name: /Cancel reservation/ }),
    );
    await waitFor(() => expect(within(rowOf('GW-A-05')).queryByText(/Held for/)).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent(
      'The reservation on bed GW-A-05 is cancelled.',
    );
  }, 20_000);

  it('asks for the patient', async () => {
    await openBoard();
    await userEvent.click(within(rowOf('GW-A-05')).getByRole('button', { name: /Reserve bed/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reserve bed' }));
    expect(await screen.findByText('Choose the patient.')).toBeInTheDocument();
  });

  it('refuses to hold a patient on two beds', async () => {
    await openBoard();
    await reserve('GW-A-05', 'MRN-PTH-00010');
    await waitFor(() => expect(within(rowOf('GW-A-05')).getByText(/Held for/)).toBeInTheDocument());
    await reserve('GW-A-06', 'MRN-PTH-00010');
    expect(await screen.findByText('That patient already has a bed held.')).toBeInTheDocument();
  }, 20_000);

  it('does not offer the held bed to another patient when admitting', async () => {
    const board = renderApp({ entry: '/beds' });
    await screen.findByRole('heading', { name: 'Bed board', level: 1 });
    await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBeGreaterThan(1));
    await reserve('GW-A-05', 'MRN-PTH-00010');
    await waitFor(() => expect(within(rowOf('GW-A-05')).getByText(/Held for/)).toBeInTheDocument());
    board.unmount();

    renderApp({ entry: '/admissions/new' });
    await screen.findByRole('heading', { name: 'Admit a patient', level: 1 });
    const beds = await screen.findAllByRole('radio');
    expect(beds.some((bed) => /GW-A-05/.test(bed.closest('label')?.textContent ?? ''))).toBe(false);
    expect(beds.some((bed) => /GW-A-06/.test(bed.closest('label')?.textContent ?? ''))).toBe(true);
  }, 20_000);

  it('is not offered without bed:reserve', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bed:reserve');
    await openBoard();
    expect(screen.queryByRole('button', { name: /Reserve bed/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel reservation/ })).not.toBeInTheDocument();
  });
});
