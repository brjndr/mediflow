import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockStaffOf } from '@/mocks/handlers/staff';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { rosterConflicts } from './conflicts';
import type { RosterShift } from './types';

// The duty roster (OP-01, #195). The mock hospital has, around a Wednesday noon: two morning
// shifts, one person on call, one person with two shifts four hours apart (a rest conflict) and
// a cancelled shift. Its clinic has one shift. Only Date is faked, so the week is the same on
// any day the suite runs.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T06:30:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Finds a member of staff by typing the name into the search and choosing the match. */
async function choosePerson(dialog: HTMLElement, name: string, label = /Person/) {
  await userEvent.type(within(dialog).getByRole('combobox', { name: label }), name);
  await userEvent.click(await within(dialog).findByRole('option', { name }));
  expect(await within(dialog).findByText(`Chosen: ${name}`)).toBeInTheDocument();
}

const person = (tenantId: string, index: number) => mockStaffOf(tenantId)[index]?.name ?? '';

describe('the roster', () => {
  it('lists the week, says which shifts conflict and has no axe violations', async () => {
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    expect(await within(table).findAllByText('Conflict: less than 8 hours of rest')).toHaveLength(
      2,
    );
    expect(within(table).getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(within(table).queryByText('Cancelled')).not.toBeInTheDocument();
    expect(await screen.findByText(/2 shifts have a conflict./)).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('lists the approved leave of the week and flags a shift on a leave', async () => {
    renderApp({ entry: '/roster' });
    const panel = await screen.findByRole('region', { name: 'Approved leave this week' });
    expect(within(panel).getByText(person(HOSPITAL, 4))).toBeInTheDocument();
    // The leave that is only asked for, is not listed.
    expect(within(panel).queryByText(person(HOSPITAL, 3))).not.toBeInTheDocument();
  });

  it('shows who is on call now', async () => {
    renderApp({ entry: '/roster' });
    const panel = await screen.findByRole('region', { name: 'On call now' });
    expect(await within(panel).findByText(person(HOSPITAL, 2))).toBeInTheDocument();
    expect(within(panel).queryByText(person(HOSPITAL, 0))).not.toBeInTheDocument();
  });

  it('puts someone on duty, filling the usual hours from the kind of shift', async () => {
    renderApp({ entry: '/roster' });
    await screen.findByRole('table', { name: 'Duty roster' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a shift' }));
    const dialog = await screen.findByRole('dialog');
    await choosePerson(dialog, person(HOSPITAL, 5));
    await userEvent.selectOptions(within(dialog).getByLabelText(/Kind of shift/), 'Night');
    await waitFor(() => expect(within(dialog).getByLabelText(/Starts at/)).toHaveValue('23:00'));
    expect(within(dialog).getByLabelText(/Ends at/)).toHaveValue('07:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add shift' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      await screen.findByText(new RegExp(`${person(HOSPITAL, 5)} is on the roster`)),
    ).toBeInTheDocument();
    expect(
      await within(screen.getByRole('table', { name: 'Duty roster' })).findByText('Night'),
    ).toBeInTheDocument();
  });

  it('refuses a second shift at the same time and keeps what was chosen', async () => {
    renderApp({ entry: '/roster' });
    await screen.findByRole('table', { name: 'Duty roster' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a shift' }));
    const dialog = await screen.findByRole('dialog');
    await choosePerson(dialog, person(HOSPITAL, 0));
    const day = within(dialog).getByLabelText(/Day it starts/);
    expect(day).toHaveValue('2026-11-11');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add shift' }));
    expect(await within(dialog).findByText(/already on duty at that time/)).toBeInTheDocument();
    expect(within(dialog).getByText(`Chosen: ${person(HOSPITAL, 0)}`)).toBeInTheDocument();
  });

  it('asks for a person before adding a shift, and lets the choice be changed', async () => {
    renderApp({ entry: '/roster' });
    await screen.findByRole('table', { name: 'Duty roster' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a shift' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add shift' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();
    await choosePerson(dialog, person(HOSPITAL, 3));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose someone else' }));
    expect(within(dialog).getByRole('combobox', { name: /Person/ })).toHaveValue('');
    await choosePerson(dialog, person(HOSPITAL, 4));
  });

  it('cancels a shift after a confirmation', async () => {
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    const row = (await within(table).findAllByText(person(HOSPITAL, 1)))[0]?.closest(
      'tr',
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Cancel shift/ }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel shift' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(
      await screen.findByText(new RegExp(`shift of ${person(HOSPITAL, 1)} is cancelled`)),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(table).queryByText(person(HOSPITAL, 1))).not.toBeInTheDocument(),
    );
  });

  it('shows another hospital only its own shifts', async () => {
    setTenantFeature(CLINIC, 'roster', true);
    grantPermission(CLINIC, 'doctor', 'roster:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    expect(await within(table).findByText(person(CLINIC, 0))).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Add a shift' })).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(HOSPITAL, 'roster', false);
    renderApp({ entry: '/roster' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('table', { name: 'Duty roster' })).not.toBeInTheDocument();
  });

  it('is refused without the permission', async () => {
    revokePermission(HOSPITAL, 'admin', 'roster:read');
    renderApp({ entry: '/roster' });
    expect(await screen.findByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
  });

  it('does not offer to add or cancel without roster:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'roster:manage');
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    await within(table).findAllByText('Scheduled');
    expect(screen.queryByRole('button', { name: 'Add a shift' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /^Cancel shift/ })).toBeNull();
  });
});

describe('shift templates, copied weeks and swaps (#592)', () => {
  it("lists the hospital's templates and adds one", async () => {
    renderApp({ entry: '/roster' });
    const panel = await screen.findByRole('region', { name: 'Shift templates' });
    expect(await within(panel).findByText('Early ward round')).toBeInTheDocument();
    expect(within(panel).getByText('06:30 to 14:30')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Add a template' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Late cover');
    await userEvent.selectOptions(within(dialog).getByLabelText(/Kind of shift/), 'Evening');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add template' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(panel).findByText('Late cover')).toBeInTheDocument();
    expect(await screen.findByText(/The template Late cover is added./)).toBeInTheDocument();
  });

  it('refuses a template whose name is taken, keeping what was typed', async () => {
    renderApp({ entry: '/roster' });
    const panel = await screen.findByRole('region', { name: 'Shift templates' });
    await userEvent.click(await within(panel).findByRole('button', { name: 'Add a template' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'early WARD round');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add template' }));
    expect(
      await within(dialog).findByText('A template already has that name.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('early WARD round');
  });

  it('retires a template after a confirmation', async () => {
    renderApp({ entry: '/roster' });
    const panel = await screen.findByRole('region', { name: 'Shift templates' });
    const row = (await within(panel).findByText('Early ward round')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Retire template/ }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Retire template' }));
    await waitFor(() =>
      expect(within(panel).queryByText('Early ward round')).not.toBeInTheDocument(),
    );
  });

  it('fills the kind and the hours of a shift from a template', async () => {
    renderApp({ entry: '/roster' });
    await screen.findByRole('table', { name: 'Duty roster' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a shift' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      await within(dialog).findByLabelText('Template'),
      'Early ward round (06:30 to 14:30)',
    );
    await waitFor(() => expect(within(dialog).getByLabelText(/Starts at/)).toHaveValue('06:30'));
    expect(within(dialog).getByLabelText(/Ends at/)).toHaveValue('14:30');
  });

  it('copies the week forward and says what was added', async () => {
    renderApp({ entry: '/roster' });
    await screen.findByRole('table', { name: 'Duty roster' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy week forward' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy shifts' }));
    expect(await within(dialog).findByText(/shifts? w(as|ere) added\./)).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    const table = screen.getByRole('table', { name: 'Duty roster' });
    await waitFor(() => expect(within(table).getAllByText('Scheduled').length).toBeGreaterThan(0));
  });

  it('refuses a number of weeks that is not 1 to 12', async () => {
    renderApp({ entry: '/roster' });
    await screen.findByRole('table', { name: 'Duty roster' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy week forward' }));
    const dialog = await screen.findByRole('dialog');
    const weeks = within(dialog).getByLabelText(/Weeks to fill/);
    await userEvent.clear(weeks);
    await userEvent.type(weeks, '13');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy shifts' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  });

  it('hands a shift to someone else', async () => {
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    const row = (await within(table).findAllByText(person(HOSPITAL, 1)))[0]?.closest(
      'tr',
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Swap shift/ }));
    const dialog = await screen.findByRole('dialog');
    await choosePerson(dialog, person(HOSPITAL, 5), /Hand it to/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      await screen.findByText(new RegExp(`shift of ${person(HOSPITAL, 1)} is swapped`)),
    ).toBeInTheDocument();
    expect(await within(table).findByText(person(HOSPITAL, 5))).toBeInTheDocument();
  });

  it('exchanges two shifts', async () => {
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    const row = (await within(table).findAllByText(person(HOSPITAL, 0)))[0]?.closest(
      'tr',
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Swap shift/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/What to do/),
      'Exchange with another shift',
    );
    const other = await within(dialog).findByLabelText(/Exchange with/);
    await userEvent.selectOptions(other, within(other).getAllByRole('option')[1] as HTMLElement);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      await screen.findByText(new RegExp(`shift of ${person(HOSPITAL, 0)} is swapped`)),
    ).toBeInTheDocument();
  });

  it('says so when the other person is already on duty then', async () => {
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    // The person on call overlaps the morning shifts.
    const row = (await within(table).findAllByText(person(HOSPITAL, 1)))[0]?.closest(
      'tr',
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Swap shift/ }));
    const dialog = await screen.findByRole('dialog');
    await choosePerson(dialog, person(HOSPITAL, 2), /Hand it to/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Swap' }));
    expect(
      await within(dialog).findByText('The other person is already on duty at that time.'),
    ).toBeInTheDocument();
  });

  it('offers none of it without roster:manage, and shows templates to readers', async () => {
    revokePermission(HOSPITAL, 'admin', 'roster:manage');
    renderApp({ entry: '/roster' });
    const table = await screen.findByRole('table', { name: 'Duty roster' });
    await within(table).findAllByText('Scheduled');
    const panel = await screen.findByRole('region', { name: 'Shift templates' });
    expect(await within(panel).findByText('Early ward round')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy week forward' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a template' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /^Swap shift/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /^Retire template/ })).toBeNull();
  });

  it("shows another hospital none of the first one's templates", async () => {
    setTenantFeature(CLINIC, 'roster', true);
    grantPermission(CLINIC, 'doctor', 'roster:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/roster' });
    const panel = await screen.findByRole('region', { name: 'Shift templates' });
    expect(await within(panel).findByText(/No templates yet/)).toBeInTheDocument();
    expect(within(panel).queryByText('Early ward round')).not.toBeInTheDocument();
  });

  it('has no axe violations with the templates panel', async () => {
    renderApp({ entry: '/roster' });
    const panel = await screen.findByRole('region', { name: 'Shift templates' });
    await within(panel).findByText('Early ward round');
    await expectNoAxeViolations();
  });
});

describe('leave requests', () => {
  const leaveTable = () => screen.findByRole('table', { name: 'Leave' });
  const rowOf = async (name: string) =>
    (await within(await leaveTable()).findByText(name)).closest('tr') as HTMLElement;

  it('lists requests with who decided, and has no axe violations', async () => {
    renderApp({ entry: '/roster' });
    const table = await leaveTable();
    expect(await within(table).findByText(person(HOSPITAL, 3))).toBeInTheDocument();
    expect(within(table).getByText('Waiting for a decision')).toBeInTheDocument();
    expect(within(table).getByText('Approved by Admin')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('lets a manager approve a request, then says so', async () => {
    renderApp({ entry: '/roster' });
    const row = await rowOf(person(HOSPITAL, 3));
    await userEvent.click(within(row).getByRole('button', { name: /^Approve/ }));
    expect(
      await screen.findByText(new RegExp(`leave of ${person(HOSPITAL, 3)} is approved`)),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText(/^Approved by/)).toBeInTheDocument());
  });

  it('asks for leave for oneself, and cannot decide on it', async () => {
    renderApp({ entry: '/roster' });
    await leaveTable();
    await userEvent.click(screen.getByRole('button', { name: 'Ask for leave' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/First day/), {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Last day/), {
      target: { value: '2026-12-03' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Your leave request is sent.')).toBeInTheDocument();
    const mine = (await within(await leaveTable()).findAllByText('Waiting for a decision')).length;
    expect(mine).toBe(2);
    const own = within(await leaveTable())
      .getAllByRole('button', { name: /^Approve/ })
      .filter((button) => button.getAttribute('aria-disabled') === 'true');
    // The approved row and the new request of the signed-in person.
    expect(own).toHaveLength(2);
  });

  it('refuses a last day before the first', async () => {
    renderApp({ entry: '/roster' });
    await leaveTable();
    await userEvent.click(screen.getByRole('button', { name: 'Ask for leave' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/First day/), {
      target: { value: '2026-12-05' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Last day/), {
      target: { value: '2026-12-03' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(
      await within(dialog).findByText('Choose one of the available options.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Your leave request is sent.')).not.toBeInTheDocument();
  });

  it('keeps a person off new shifts while their leave is approved', async () => {
    renderApp({ entry: '/roster' });
    await screen.findByRole('table', { name: 'Duty roster' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a shift' }));
    const dialog = await screen.findByRole('dialog');
    await choosePerson(dialog, person(HOSPITAL, 4));
    fireEvent.change(within(dialog).getByLabelText(/Day it starts/), {
      target: { value: '2026-11-20' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add shift' }));
    expect(await within(dialog).findByText(/on approved leave/)).toBeInTheDocument();
  });

  it('is not offered without roster:requestLeave', async () => {
    revokePermission(HOSPITAL, 'admin', 'roster:requestLeave');
    renderApp({ entry: '/roster' });
    await leaveTable();
    expect(screen.queryByRole('button', { name: 'Ask for leave' })).not.toBeInTheDocument();
  });

  it('shows another hospital none of the first one’s requests', async () => {
    setTenantFeature(CLINIC, 'roster', true);
    grantPermission(CLINIC, 'doctor', 'roster:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/roster' });
    const table = await leaveTable();
    expect(await within(table).findByText('No leave requested or coming up.')).toBeInTheDocument();
    expect(within(table).queryByText(person(HOSPITAL, 3))).not.toBeInTheDocument();
  });
});

describe('leave kinds, allowances and self approval (#667)', () => {
  const leaveTable = () => screen.findByRole('table', { name: 'Leave' });

  async function setRules(sick: string, selfApproval: string) {
    await userEvent.click(await screen.findByRole('button', { name: 'Leave rules' }));
    const dialog = await screen.findByRole('dialog');
    const field = await within(dialog).findByLabelText(/Sick leave: days a year/);
    if (sick) await userEvent.type(field, sick);
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/Approving your own leave/),
      selfApproval,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('The leave rules are saved.')).toBeInTheDocument();
  }

  async function ask(kind: string, first: string, last: string) {
    await userEvent.click(screen.getByRole('button', { name: 'Ask for leave' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText(/Kind of leave/), kind);
    fireEvent.change(within(dialog).getByLabelText(/First day/), { target: { value: first } });
    fireEvent.change(within(dialog).getByLabelText(/Last day/), { target: { value: last } });
    return dialog;
  }

  it('shows the days left for the chosen kind and refuses more than the year allows', async () => {
    renderApp({ entry: '/roster' });
    await leaveTable();
    await setRules('3', 'never');
    const dialog = await ask('sick', '2026-12-01', '2026-12-05');
    expect(await within(dialog).findByText(/3 of 3 days left this year/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(
      await within(dialog).findByText(/more days than this year allows for this kind/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Your leave request is sent.')).not.toBeInTheDocument();
  });

  it('lists a request with its kind and days', async () => {
    renderApp({ entry: '/roster' });
    await leaveTable();
    const dialog = await ask('sick', '2026-12-01', '2026-12-02');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Your leave request is sent.')).toBeInTheDocument();
    expect(await within(await leaveTable()).findByText('Sick leave, 2 days')).toBeInTheDocument();
  });

  it('lets the manager approve their own leave once the hospital allows it', async () => {
    renderApp({ entry: '/roster' });
    await leaveTable();
    const dialog = await ask('annual', '2026-12-01', '2026-12-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Your leave request is sent.')).toBeInTheDocument();
    const own = () =>
      within(
        within(screen.getByRole('table', { name: 'Leave' }))
          .getByText('Annual leave, 1 day')
          .closest('tr') as HTMLElement,
      );
    expect(own().getByRole('button', { name: /^Approve/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await setRules('', 'sole_manager');
    await waitFor(() =>
      expect(own().getByRole('button', { name: /^Approve/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await userEvent.click(own().getByRole('button', { name: /^Approve/ }));
    expect(await screen.findByText(/\(their own leave\)/)).toBeInTheDocument();
  });

  it('offers the rules only with roster:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'roster:manage');
    renderApp({ entry: '/roster' });
    await leaveTable();
    expect(screen.queryByRole('button', { name: 'Leave rules' })).not.toBeInTheDocument();
  });
});

describe('rosterConflicts', () => {
  const shift = (id: string, userId: string, from: string, to: string, status = 'scheduled') =>
    ({
      id,
      tenantId: 't',
      userId,
      userName: userId,
      shiftKind: 'day',
      startsAt: from,
      endsAt: to,
      status,
      version: 1,
    }) as RosterShift;

  it('flags overlaps and short rests per person, not across people or cancelled shifts', () => {
    const flagged = rosterConflicts([
      shift('a', 'u1', '2026-11-10T08:00:00Z', '2026-11-10T16:00:00Z'),
      shift('b', 'u1', '2026-11-10T15:00:00Z', '2026-11-10T20:00:00Z'),
      shift('c', 'u2', '2026-11-10T08:00:00Z', '2026-11-10T16:00:00Z'),
      shift('d', 'u2', '2026-11-10T18:00:00Z', '2026-11-10T22:00:00Z', 'cancelled'),
      shift('e', 'u3', '2026-11-10T08:00:00Z', '2026-11-10T16:00:00Z'),
      shift('f', 'u3', '2026-11-11T08:00:00Z', '2026-11-11T16:00:00Z'),
    ]);
    expect(flagged.get('a')).toBe('overlap');
    expect(flagged.get('b')).toBe('overlap');
    expect(flagged.has('c')).toBe(false);
    expect(flagged.has('e')).toBe(false);
  });
});
