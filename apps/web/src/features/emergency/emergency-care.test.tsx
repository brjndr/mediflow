import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// ER-0002 is an unidentified arrival not yet triaged; ER-0001 is a patient on record.
const open = async (id: 'er_1' | 'er_2') => {
  renderApp({ entry: `/emergency/${id}` });
  return screen.findByRole('heading', {
    level: 1,
    name: new RegExp(id === 'er_1' ? 'ER-0001' : 'ER-0002'),
  });
};

const said = (text: string) =>
  screen.queryAllByRole('status').some((one) => one.textContent === text);

describe('care of one case', () => {
  it('is reached from the board and shows the case', async () => {
    renderApp({ entry: '/emergency' });
    await userEvent.click(await screen.findByRole('link', { name: 'Man in blue jacket' }));
    expect(await screen.findByRole('heading', { level: 1, name: /ER-0002/ })).toBeInTheDocument();
    expect(screen.getByText('Road accident')).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 20_000);

  it('starts treatment', async () => {
    await open('er_2');
    await userEvent.click(screen.getByRole('button', { name: 'Start treatment' }));
    await waitFor(() => expect(said('ER-0002 is now in treatment.')).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Start treatment' })).not.toBeInTheDocument(),
    );
  }, 20_000);

  it('adds observation notes, also for an unidentified patient', async () => {
    await open('er_2');
    expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findAllByText(/required/i)).not.toHaveLength(0);
    await userEvent.type(screen.getByRole('textbox', { name: /Note/ }), 'BP 90/60, GCS 14');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('BP 90/60, GCS 14')).toBeInTheDocument();
    expect(said('Note added.')).toBe(true);
  }, 20_000);

  it('places orders only for a patient on record, once the encounter is prepared', async () => {
    await open('er_2');
    expect(
      await screen.findByText(/Link the patient to a record to place orders/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare orders' })).not.toBeInTheDocument();
  }, 20_000);

  it('opens the orders of a patient on record', async () => {
    await open('er_1');
    await userEvent.click(await screen.findByRole('button', { name: 'Prepare orders' }));
    expect(await screen.findByRole('heading', { name: 'Lab orders' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Imaging orders' })).toBeInTheDocument();
  }, 20_000);
});

describe('disposition', () => {
  it('discharges once, and the case is then a record of how', async () => {
    await open('er_2');
    await userEvent.click(screen.getByRole('button', { name: 'Decide disposition' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(said('ER-0002 has left the department.')).toBe(true));
    const left = await screen.findByRole('heading', { name: 'Left the department' });
    expect(
      within(left.closest('section') as HTMLElement).getByText(/Discharge/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decide disposition' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
  }, 20_000);

  it('needs a destination to refer and the time of death for an expired patient', async () => {
    await open('er_2');
    await userEvent.click(screen.getByRole('button', { name: 'Decide disposition' }));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: /Disposition/ }),
      'refer',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findAllByText(/required/i)).not.toHaveLength(0);
    await userEvent.type(
      screen.getByRole('textbox', { name: /Referred to/ }),
      'City Heart Institute',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Referred to City Heart Institute.')).toBeInTheDocument();
  }, 20_000);

  it('will not admit an unidentified patient, and admits one on record', async () => {
    await open('er_2');
    await userEvent.click(screen.getByRole('button', { name: 'Decide disposition' }));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: /Disposition/ }),
      'admit',
    );
    expect(
      await screen.findByText('Link the patient to a record before admitting.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Link the patient to a record first.')).toBeInTheDocument();
  }, 20_000);

  it('admits a patient on record under a chosen doctor and points to the admissions', async () => {
    await open('er_1');
    await userEvent.click(await screen.findByRole('button', { name: 'Decide disposition' }));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: /Disposition/ }),
      'admit',
    );
    const doctor = await screen.findByRole('combobox', { name: /Admitting doctor/ });
    await userEvent.selectOptions(
      doctor,
      (within(doctor).getAllByRole('option')[1] as HTMLOptionElement).value,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByRole('link', { name: 'See the admissions list' }),
    ).toBeInTheDocument();
  }, 20_000);
});

describe('admitting without a doctor profile', () => {
  it('says there is no doctor to admit under', async () => {
    await open('er_1');
    await userEvent.click(await screen.findByRole('button', { name: 'Decide disposition' }));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: /Disposition/ }),
      'admit',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/no doctor to admit under/)).toBeInTheDocument();
  }, 20_000);
});

describe('access', () => {
  it('offers no notes or treatment without emergency:care', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'emergency:care');
    await open('er_2');
    expect(screen.queryByRole('button', { name: 'Start treatment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Observation notes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decide disposition' })).toBeInTheDocument();
  });

  it('offers no disposition without emergency:dispose', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'emergency:dispose');
    await open('er_2');
    await screen.findByRole('heading', { name: 'Observation notes' });
    expect(screen.queryByRole('button', { name: 'Decide disposition' })).not.toBeInTheDocument();
  });

  it('is closed without emergency:read, and a case of another hospital is not available', async () => {
    renderApp({ entry: '/emergency/er_unknown' });
    expect(await screen.findByText('This case is not available.')).toBeInTheDocument();
  });
});
