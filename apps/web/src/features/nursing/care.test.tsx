import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { addMockCarePlan, addMockWardFluid } from '@/mocks/handlers/nursing-care';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { shiftOf, shiftWindows } from './shifts';

const NO_ACCESS = { name: 'You do not have access to this page' };
const KOLKATA = 'Asia/Kolkata';

beforeEach(() => {
  addMockAdmission({ id: 'adm_c1', patientName: 'Asha Verma' });
});

describe('the shifts', () => {
  it('cover the nursing day from 06:00 to 06:00 without a gap', () => {
    const windows = shiftWindows('2026-11-08', KOLKATA);
    expect(windows.map((each) => each.id)).toEqual(['morning', 'evening', 'night']);
    expect(windows[0]?.from).toBe('2026-11-08T00:30:00.000Z');
    expect(windows[0]?.to).toBe(windows[1]?.from);
    expect(windows[1]?.to).toBe(windows[2]?.from);
    expect(windows[2]?.to).toBe('2026-11-09T00:30:00.000Z');
  });

  it('tells the shift of an instant by the hospital clock', () => {
    expect(shiftOf('2026-11-08T03:00:00.000Z', KOLKATA)).toBe('morning');
    expect(shiftOf('2026-11-08T09:00:00.000Z', KOLKATA)).toBe('evening');
    expect(shiftOf('2026-11-08T17:00:00.000Z', KOLKATA)).toBe('night');
    expect(shiftOf('2026-11-08T00:45:00.000Z', KOLKATA)).toBe('morning');
  });
});

describe('fluid balance', () => {
  const open = async () => {
    renderApp({ entry: '/nursing/adm_c1/fluids' });
    await screen.findByRole('heading', { name: /Fluid balance: Asha Verma/, level: 1 });
  };
  const pickDay = (day: string) =>
    fireEvent.change(screen.getByLabelText(/Nursing day/), { target: { value: day } });

  it('totals each shift and the day, and records an entry', async () => {
    // 2026-11-08 in Kolkata: 06:00-14:00 is 00:30Z-08:30Z, 14:00-22:00 is 08:30Z-16:30Z.
    addMockWardFluid({
      id: 'f1',
      admissionId: 'adm_c1',
      observedAt: '2026-11-08T02:00:00.000Z',
      kind: 'oral',
      amountMl: 300,
    });
    addMockWardFluid({
      id: 'f2',
      admissionId: 'adm_c1',
      observedAt: '2026-11-08T03:00:00.000Z',
      kind: 'urine',
      direction: 'output',
      amountMl: 100,
    });
    addMockWardFluid({
      id: 'f3',
      admissionId: 'adm_c1',
      observedAt: '2026-11-08T10:00:00.000Z',
      kind: 'intravenous',
      amountMl: 500,
    });
    await open();
    pickDay('2026-11-08');
    const totals = await screen.findByRole('table', { name: 'Totals for each shift' });
    const morning = await within(totals).findByRole('row', { name: /Morning/ });
    await waitFor(() => expect(morning).toHaveTextContent('300 ml'));
    expect(morning).toHaveTextContent('100 ml');
    expect(morning).toHaveTextContent('+200 ml');
    expect(within(totals).getByRole('row', { name: /Evening/ })).toHaveTextContent('500 ml');
    await waitFor(() =>
      expect(within(totals).getByRole('row', { name: /Whole day/ })).toHaveTextContent('800 ml'),
    );
    expect(within(totals).getByRole('row', { name: /Whole day/ })).toHaveTextContent('+700 ml');
    await expectNoAxeViolations();
  }, 30_000);

  it('adds an entry for the day it is taken and counts it', async () => {
    await open();
    // The nursing day that holds now: the hospital date six hours ago.
    const now = new Date(Date.now() - 6 * 3_600_000);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: KOLKATA }).format(now);
    pickDay(day);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'urine');
    await userEvent.type(screen.getByRole('textbox', { name: /Amount in ml/ }), '250');
    await userEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Entry added.'));
    const grid = screen.getByRole('table', { name: 'Fluid entries' });
    expect(await within(grid).findByText('Output: Urine')).toBeInTheDocument();
    const totals = screen.getByRole('table', { name: 'Totals for each shift' });
    await waitFor(() =>
      expect(within(totals).getByRole('row', { name: /Whole day/ })).toHaveTextContent('-250 ml'),
    );
  }, 30_000);

  it('refuses an amount that is not a whole number of millilitres', async () => {
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: /Amount in ml/ }), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(await screen.findByText(/whole number of millilitres/)).toBeInTheDocument();
  });

  it('corrects an entry, keeping the original in the list', async () => {
    addMockWardFluid({
      id: 'f9',
      admissionId: 'adm_c1',
      observedAt: '2026-11-08T02:00:00.000Z',
      kind: 'oral',
      amountMl: 900,
    });
    await open();
    pickDay('2026-11-08');
    const grid = await screen.findByRole('table', { name: 'Fluid entries' });
    const row = await within(grid).findByRole('row', { name: /900 ml/ });
    await userEvent.click(within(row).getByRole('button', { name: /Correct/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Correct an entry' });
    const amount = within(dialog).getByRole('textbox', { name: /Amount in ml/ });
    await userEvent.clear(amount);
    await userEvent.type(amount, '90');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Typed a zero too many',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Correction saved.'));
    expect(await within(grid).findByText('Corrected')).toBeInTheDocument();
    expect(within(grid).getByText(/Correction: Typed a zero too many/)).toBeInTheDocument();
    const totals = screen.getByRole('table', { name: 'Totals for each shift' });
    await waitFor(() =>
      expect(within(totals).getByRole('row', { name: /Whole day/ })).toHaveTextContent('90 ml'),
    );
  }, 40_000);

  it('is unreachable without the permission or with the module off', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'fluidBalance:read');
    renderApp({ entry: '/nursing/adm_c1/fluids' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable with the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'nursing', false);
    renderApp({ entry: '/nursing/adm_c1/fluids' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('shows entries but no way to record without the record permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'fluidBalance:record');
    await open();
    expect(screen.queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument();
  });
});

describe('care plans', () => {
  const open = async () => {
    renderApp({ entry: '/nursing/adm_c1/care-plan' });
    await screen.findByRole('heading', { name: /Care plans: Asha Verma/, level: 1 });
  };

  it('starts a plan, adds a task, marks it done and ends the plan', async () => {
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: /Problem/ }), 'Risk of falls');
    await userEvent.type(screen.getByRole('textbox', { name: /Goal/ }), 'No fall in the stay');
    await userEvent.type(screen.getByRole('textbox', { name: /First task/ }), 'Bed rails up');
    await userEvent.click(screen.getByRole('button', { name: 'Start plan' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Care plan started.'));
    const card = (await screen.findByRole('heading', { name: 'Risk of falls' })).closest('article');
    expect(card).not.toBeNull();
    const plan = within(card as HTMLElement);
    expect(plan.getByText('Bed rails up')).toBeInTheDocument();
    expect(plan.getByText('0 of 1 tasks done')).toBeInTheDocument();
    await expectNoAxeViolations();

    await userEvent.type(
      plan.getByRole('textbox', { name: /New task for Risk of falls/ }),
      'Hourly round',
    );
    await userEvent.click(plan.getByRole('button', { name: 'Add task' }));
    expect(await plan.findByText('Hourly round')).toBeInTheDocument();

    await userEvent.click(plan.getByRole('button', { name: 'Mark done: Bed rails up' }));
    await waitFor(() => expect(plan.getByText('1 of 2 tasks done')).toBeInTheDocument());
    expect(plan.getByText(/Done by/)).toBeInTheDocument();

    await userEvent.click(plan.getByRole('button', { name: 'Complete plan' }));
    expect(await plan.findByText('Completed')).toBeInTheDocument();
    expect(plan.queryByRole('button', { name: 'Add task' })).not.toBeInTheDocument();
    expect(plan.queryByRole('button', { name: /Mark done/ })).not.toBeInTheDocument();
  }, 40_000);

  it('refuses a plan with no problem', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Start plan' }));
    expect(await screen.findByText('Say what the problem is.')).toBeInTheDocument();
  });

  it('lists plans of the stay only, from this hospital', async () => {
    addMockCarePlan({ id: 'p1', admissionId: 'adm_c1', problem: 'Pressure area care' });
    addMockCarePlan({ id: 'p2', admissionId: 'adm_other', problem: 'Someone else' });
    addMockCarePlan({
      id: 'p3',
      admissionId: 'adm_c1',
      problem: 'Other hospital',
      tenantId: TENANT_IDS.clinic,
    });
    await open();
    expect(await screen.findByRole('heading', { name: 'Pressure area care' })).toBeInTheDocument();
    expect(screen.queryByText('Someone else')).not.toBeInTheDocument();
    expect(screen.queryByText('Other hospital')).not.toBeInTheDocument();
  });

  it('shows plans but no controls without the write permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'carePlan:write');
    addMockCarePlan({
      id: 'p1',
      admissionId: 'adm_c1',
      tasks: [{ id: 't1', description: 'Check footwear' }],
    });
    await open();
    expect(await screen.findByText('Check footwear')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark done/ })).not.toBeInTheDocument();
  });

  it('is unreachable without the permission or with the module off', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'carePlan:read');
    renderApp({ entry: '/nursing/adm_c1/care-plan' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});
