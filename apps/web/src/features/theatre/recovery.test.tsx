import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { SEEDED_DAY } from '@/mocks/handlers/theatre';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const surgeryGrid = () => screen.getByRole('table', { name: 'Surgeries of the day' });
const seededRow = () =>
  within(surgeryGrid())
    .getAllByRole('row')
    .find((row) => /9:30.*11:00/.test(within(row).queryAllByRole('cell')[0]?.textContent ?? ''));
const rowButton = (name: RegExp | string) =>
  within(seededRow() as HTMLElement).getByRole('button', { name });

async function openTheatre() {
  renderApp({ entry: '/theatre' });
  await screen.findByRole('heading', { name: 'Operation theatre', level: 1 });
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: SEEDED_DAY } });
  await waitFor(() => expect(seededRow()).toBeDefined(), { timeout: 10_000 });
}

describe('recovery notes and orders', () => {
  it('waits for the surgery to start, then appends notes that are never changed', async () => {
    await openTheatre();
    await userEvent.click(rowButton(/Recovery and orders/));
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/written once the surgery has started/)).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
    await userEvent.click(
      within(dialog).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(rowButton(/Start surgery/));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Surgery started'));
    await userEvent.click(rowButton(/Recovery and orders/));
    dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('No recovery notes have been written yet.'),
    ).toBeVisible();
    await expectNoAxeViolations();

    // A note is asked for, and the pain score is 0 to 10.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add note' }));
    expect(await within(dialog).findAllByText(/required/i)).not.toHaveLength(0);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /^Note/ }),
      'Awake, comfortable',
    );
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Pain score/ }), '11');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add note' }));
    expect(screen.queryByRole('list', { name: 'Recovery notes' })).not.toBeInTheDocument();

    await userEvent.clear(within(dialog).getByRole('textbox', { name: /Pain score/ }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Pain score/ }), '3');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /Condition/ }),
      'ready_for_ward',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add note' }));
    const list = await within(dialog).findByRole('list', { name: 'Recovery notes' });
    expect(within(list).getByText('Awake, comfortable')).toBeVisible();
    expect(within(list).getByText(/Ready for the ward/)).toBeVisible();
    expect(within(list).getByText(/Pain 3 of 10/)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Recovery note added.');
    // Orders need a visit; none is linked.
    expect(within(dialog).getByText(/Orders are placed on a visit/)).toBeVisible();
    await expectNoAxeViolations(dialog);
  }, 60_000);

  it('is read-only without surgery:perform', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'surgery:perform');
    await openTheatre();
    await userEvent.click(rowButton(/Recovery and orders/));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('No recovery notes have been written yet.');
    expect(within(dialog).queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
  }, 40_000);

  it('offers no row action without theatre:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'theatre:read');
    renderApp({ entry: '/theatre' });
    expect(screen.queryByRole('button', { name: /Recovery and orders/ })).not.toBeInTheDocument();
  });
});
