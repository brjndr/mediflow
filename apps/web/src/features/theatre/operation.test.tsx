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

/** Shows the seeded day and waits for its surgery. */
async function openTheatre() {
  renderApp({ entry: '/theatre' });
  await screen.findByRole('heading', { name: 'Operation theatre', level: 1 });
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: SEEDED_DAY } });
  await waitFor(() => expect(seededRow()).toBeDefined(), { timeout: 10_000 });
}

const rowButton = (name: RegExp | string) =>
  within(seededRow() as HTMLElement).getByRole('button', { name });

/** Starts the seeded surgery from its row, then opens the operation dialog. */
async function startAndOpen() {
  await openTheatre();
  await userEvent.click(rowButton(/Start surgery/));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Surgery started'));
  await userEvent.click(rowButton(/Operation note and stock/));
  return screen.findByRole('dialog');
}

describe('operation note, stock used and the visit', () => {
  it('waits for the surgery to start, then keeps a draft, signs it and takes addenda', async () => {
    await openTheatre();
    await userEvent.click(rowButton(/Operation note and stock/));
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/written once the surgery has started/)).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    await userEvent.click(
      within(dialog).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(rowButton(/Start surgery/));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Surgery started'));
    await userEvent.click(rowButton(/Operation note and stock/));
    dialog = await screen.findByRole('dialog');
    await expectNoAxeViolations();

    // The procedure is asked for first.
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findAllByText(/required/i)).not.toHaveLength(0);

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Procedure performed/ }),
      'Appendicectomy',
    );
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Findings/ }), 'Inflamed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await within(dialog).findByText(/saved as a draft/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign note' }));
    await within(dialog).findByText(/Operation note signed/);
    expect(await within(dialog).findByText('Inflamed')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Sign note' })).not.toBeInTheDocument();

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Addendum/ }),
      'Drain left in',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add addendum' }));
    expect(await within(dialog).findByText('Drain left in')).toBeInTheDocument();
  }, 60_000);

  it('records stock used and lists it', async () => {
    const dialog = await startAndOpen();
    expect(await within(dialog).findByText(/No stock has been recorded/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Item used' }), 'acec');
    const [first] = await within(await within(dialog).findByRole('listbox')).findAllByRole(
      'option',
    );
    await userEvent.click(first as HTMLElement);
    await within(dialog).findByText(/^Item: /);
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /Take from/ }),
      'Main store',
    );
    const batch = within(dialog).getByRole('combobox', { name: /Batch/ });
    await waitFor(() => expect(within(batch).getAllByRole('option').length).toBeGreaterThan(1));
    await userEvent.selectOptions(batch, within(batch).getAllByRole('option')[1] as HTMLElement);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Units used/ }), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record stock used' }));
    await within(dialog).findByText(/Stock recorded/);
    const list = await within(dialog).findByRole('list', { name: 'Stock used in this surgery' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent(/2 used/);
    expect(list).toHaveTextContent(/Main store/);
  }, 60_000);

  it('says so when no visit is linked and offers only the patient’s open visits', async () => {
    const dialog = await startAndOpen();
    expect(await within(dialog).findByText(/nothing is charged for this surgery/)).toBeVisible();
    expect(
      within(dialog).getByRole('combobox', { name: /Open visit of this patient/ }),
    ).toBeVisible();
  }, 40_000);

  it('is read-only without surgery:perform', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'surgery:perform');
    await openTheatre();
    await userEvent.click(rowButton(/Operation note and stock/));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/No stock has been recorded/);
    expect(within(dialog).queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Record stock used' }),
    ).not.toBeInTheDocument();
  }, 40_000);
});
