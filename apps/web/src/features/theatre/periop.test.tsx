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

/** Opens the checklist dialog of the seeded surgery. */
const openDialog = async () => {
  renderApp({ entry: '/theatre' });
  await screen.findByRole('heading', { name: 'Operation theatre', level: 1 });
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: SEEDED_DAY } });
  await waitFor(() => expect(seededRow()).toBeDefined(), { timeout: 10_000 });
  await userEvent.click(
    within(seededRow() as HTMLElement).getByRole('button', { name: /Checklist and anaesthesia/ }),
  );
  return screen.findByRole('dialog');
};
const mark = (step: string) => screen.getByRole('button', { name: `Mark done: ${step}` });

describe('pre-operative checklist and anaesthesia record', () => {
  it('times and signs steps in phase order, and keeps later phases closed', async () => {
    const dialog = await openDialog();
    await within(dialog).findByText('Fitness for surgery has not been assessed.');
    expect(within(dialog).getAllByText('Opens when the earlier phases are done.')).toHaveLength(3);
    await expectNoAxeViolations();

    // A later phase refuses to start: the button is announced as unavailable and does nothing.
    const later = mark('Known allergies checked');
    expect(later).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(later);
    expect(within(dialog).queryByText(/Signed by/)).not.toBeInTheDocument();

    for (const step of [
      'Consent for the procedure is signed',
      'Site is marked',
      'Fasting is confirmed',
    ]) {
      await userEvent.click(mark(step));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`Done: ${step}`));
    }
    expect(within(dialog).getAllByText(/^Signed by .+, /)).toHaveLength(3);
    await waitFor(() =>
      expect(mark('Known allergies checked')).not.toHaveAttribute('aria-disabled'),
    );
  }, 40_000);

  it('records fitness and asks for a choice first', async () => {
    const dialog = await openDialog();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Save assessment' }));
    expect(await within(dialog).findAllByText(/required/i)).not.toHaveLength(0);
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /Fitness for surgery/ }),
      'Fit with conditions',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save assessment' }));
    await waitFor(() =>
      expect(within(dialog).getByText(/Assessed as Fit with conditions by/)).toBeInTheDocument(),
    );
  }, 30_000);

  it('saves an anaesthesia draft, signs it once and then shows it read-only', async () => {
    const dialog = await openDialog();
    await userEvent.selectOptions(
      await within(dialog).findByRole('combobox', { name: /Technique/ }),
      'Spinal',
    );
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /ASA class/ }),
      'ASA 2',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Drugs/ }),
      'Bupivacaine 15 mg',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('draft saved'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign record' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('record signed'));
    expect(await within(dialog).findByText('Bupivacaine 15 mg')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Sign record' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  }, 40_000);

  it('shows the record read-only without surgery:perform', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'surgery:perform');
    const dialog = await openDialog();
    expect(
      await within(dialog).findByText(/read this record but not change it/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Mark done/ })).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Save assessment' }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  }, 30_000);
});
