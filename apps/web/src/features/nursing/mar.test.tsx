import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { addMockMarEntry, addMockMarOrder } from '@/mocks/handlers/nursing-mar';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { slotsOn, slotState, slotTimes, standingEntry } from './mar-schedule';
import type { MarEntry, MarOrder } from './types';

const SCHEDULE = { name: 'Doses due' };
const HISTORY = { name: 'Chart entries' };

beforeEach(() => {
  addMockAdmission({ id: 'adm_m1', patientId: 'pth_00001', patientName: 'Asha Verma' });
  addMockMarOrder({ id: 'ord_1', admissionId: 'adm_m1' });
});

const openChart = async () => {
  renderApp({ entry: '/nursing/adm_m1/mar' });
  await screen.findByRole('heading', { name: /Medication chart: Asha Verma/, level: 1 });
  return screen.findByRole('table', SCHEDULE);
};

const firstRow = async () => {
  const grid = await openChart();
  const rows = await within(grid).findAllByRole('row', { name: /Paracetamol/ });
  return rows[0] as HTMLElement;
};

describe('the dose schedule', () => {
  const order = (frequency: string): MarOrder => ({
    id: 'o',
    drugId: 'd',
    itemName: 'X',
    dose: '1',
    route: 'oral',
    frequency,
    status: 'active',
    placedAt: '2026-11-01T00:00:00.000Z',
    dispensed: true,
  });

  it('reads times from the frequency and none from as needed', () => {
    expect(slotTimes('BD')).toEqual(['08:00', '20:00']);
    expect(slotTimes('1-0-1')).toEqual(['08:00', '21:00']);
    expect(slotTimes('1-1-1')).toEqual(['08:00', '14:00', '21:00']);
    expect(slotTimes('q8h')).toEqual(['06:00', '14:00', '22:00']);
    expect(slotTimes('SOS')).toBeNull();
    expect(slotTimes('')).toBeNull();
  });

  it('works out the same instants in the hospital timezone and skips slots before the order', () => {
    const slots = slotsOn([order('BD')], '2026-11-08', 'Asia/Kolkata');
    expect(slots.map((each) => each.scheduledAt)).toEqual([
      '2026-11-08T02:30:00.000Z',
      '2026-11-08T14:30:00.000Z',
    ]);
    const late = { ...order('BD'), placedAt: '2026-11-08T10:00:00.000Z' };
    expect(slotsOn([late], '2026-11-08', 'Asia/Kolkata')).toHaveLength(1);
  });

  it('calls a dose overdue an hour after its time and ignores corrected entries', () => {
    const due = '2026-11-08T08:00:00.000Z';
    expect(slotState(due, false, new Date('2026-11-08T08:30:00.000Z'))).toBe('due');
    expect(slotState(due, false, new Date('2026-11-08T09:30:00.000Z'))).toBe('overdue');
    expect(slotState(due, false, new Date('2026-11-08T05:00:00.000Z'))).toBe('later');
    expect(slotState(due, true, new Date('2026-11-09T05:00:00.000Z'))).toBe('recorded');
    const entry = (id: string, correctedById?: string): MarEntry => ({
      id,
      tenantId: 't',
      admissionId: 'a',
      orderId: 'o',
      drugId: 'd',
      scheduledAt: due,
      outcome: 'given',
      recordedAt: due,
      recordedById: 'u',
      recordedByName: 'U',
      ...(correctedById ? { correctedById } : {}),
    });
    expect(standingEntry([entry('1', '2'), entry('2')], 'o', due)?.id).toBe('2');
  });
});

describe('the medication chart', () => {
  it('lists the doses due and charts one as given', async () => {
    const row = await firstRow();
    await expectNoAxeViolations();
    await userEvent.click(within(row).getByRole('button', { name: /Chart dose/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Chart a dose' });
    expect(within(dialog).getByRole('textbox', { name: /Dose given/ })).toHaveValue('500 mg');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Dose charted.'));
    const history = await screen.findByRole('table', HISTORY);
    expect(await within(history).findByText('500 mg oral')).toBeInTheDocument();
    expect(within(await screen.findByRole('table', SCHEDULE)).getAllByText('Given').length).toBe(1);
  }, 30_000);

  it('asks for a reason when a dose is withheld', async () => {
    const row = await firstRow();
    await userEvent.click(within(row).getByRole('button', { name: /Chart dose/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Chart a dose' });
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /What happened/ }),
      'withheld',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    expect(await within(dialog).findByText('Say why the dose was not given.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Nil by mouth');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Dose charted.'));
    const history = await screen.findByRole('table', HISTORY);
    expect(await within(history).findByText('Withheld: Nil by mouth')).toBeInTheDocument();
  }, 30_000);

  it('asks for a reason when the dose differs from the order', async () => {
    const row = await firstRow();
    await userEvent.click(within(row).getByRole('button', { name: /Chart dose/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Chart a dose' });
    const dose = within(dialog).getByRole('textbox', { name: /Dose given/ });
    await userEvent.clear(dose);
    await userEvent.type(dose, '250 mg');
    expect(await within(dialog).findByText(/This is not the ordered dose/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    expect(
      await within(dialog).findByText('The dose is not the ordered one. Say why.'),
    ).toBeInTheDocument();
  }, 30_000);

  it('warns about an allergy and wants it confirmed', async () => {
    // The sample patient pth_00001 has a penicillin allergy on record.
    addMockAdmission({ id: 'adm_m2', patientId: 'pth_00001', patientName: 'Sample Patient' });
    addMockMarOrder({
      id: 'ord_2',
      admissionId: 'adm_m2',
      itemName: 'Penicillin V 250 mg',
      dose: '250 mg',
    });
    renderApp({ entry: '/nursing/adm_m2/mar' });
    const grid = await screen.findByRole('table', SCHEDULE);
    await screen.findByText('Penicillin (Rash)');
    const rows = await within(grid).findAllByRole('row', { name: /Penicillin V/ });
    await userEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: /Chart dose/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Chart a dose' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Penicillin');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    expect(
      await within(dialog).findByText('Confirm that you have checked the allergy.'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /checked the allergy/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Dose charted.'));
  }, 30_000);

  it('never edits an entry: amending adds a new one and keeps the old', async () => {
    const grid = await openChart();
    const rows = await within(grid).findAllByRole('row', { name: /Paracetamol/ });
    const first = rows[0] as HTMLElement;
    await userEvent.click(within(first).getByRole('button', { name: /Chart dose/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Chart a dose' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Dose charted.'));

    const again = (
      await within(await screen.findByRole('table', SCHEDULE)).findAllByRole('row', {
        name: /Paracetamol/,
      })
    )[0] as HTMLElement;
    expect(within(again).getByRole('button', { name: /Chart dose/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(again).getByRole('button', { name: /Amend/ }));
    const amend = await screen.findByRole('dialog', { name: 'Amend an entry' });
    await userEvent.selectOptions(
      within(amend).getByRole('combobox', { name: /What happened/ }),
      'refused',
    );
    await userEvent.click(within(amend).getByRole('button', { name: 'Save amendment' }));
    expect(await within(amend).findByText('Say why the dose was not given.')).toBeInTheDocument();
    await userEvent.type(
      within(amend).getByRole('textbox', { name: /Reason/ }),
      'Charted by mistake',
    );
    await userEvent.click(within(amend).getByRole('button', { name: 'Save amendment' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Amendment saved'));
    const history = await screen.findByRole('table', HISTORY);
    expect(await within(history).findByText('Amended')).toBeInTheDocument();
    expect(within(history).getByText('Amendment')).toBeInTheDocument();
    expect(
      within(history).getByText(/Refused by the patient: Charted by mistake/),
    ).toBeInTheDocument();
  }, 40_000);

  it('lists an as-needed order without a time', async () => {
    addMockMarOrder({
      id: 'ord_prn',
      admissionId: 'adm_m1',
      itemName: 'Salbutamol',
      frequency: 'SOS',
    });
    const grid = await openChart();
    const row = await within(grid).findByRole('row', { name: /Salbutamol/ });
    expect(within(row).getAllByText('As needed').length).toBeGreaterThan(0);
  });

  it('shows entries that are already on the chart', async () => {
    addMockMarEntry({
      id: 'e1',
      admissionId: 'adm_m1',
      orderId: 'ord_1',
      outcome: 'missed',
      reason: 'Patient off the ward',
    });
    await openChart();
    const history = await screen.findByRole('table', HISTORY);
    expect(await within(history).findByText('Missed: Patient off the ward')).toBeInTheDocument();
  });

  it('asks for a confirmation when the allergies cannot be read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'allergy:read');
    const row = await firstRow();
    await userEvent.click(within(row).getByRole('button', { name: /Chart dose/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Chart a dose' });
    expect(within(dialog).getByText(/could not be read here/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chart dose' }));
    expect(
      await within(dialog).findByText('Confirm that you have checked the allergy.'),
    ).toBeInTheDocument();
  }, 30_000);

  it('offers no charting without mar:record', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'mar:record');
    const row = await firstRow();
    expect(within(row).queryByRole('button', { name: /Chart dose/ })).not.toBeInTheDocument();
  });

  it('is unreachable without mar:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'mar:read');
    renderApp({ entry: '/nursing/adm_m1/mar' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });
});
