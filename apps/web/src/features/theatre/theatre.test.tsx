import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { SEEDED_DAY } from '@/mocks/handlers/theatre';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Operation theatre', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const surgeryGrid = () => screen.getByRole('table', { name: 'Surgeries of the day' });
const roomGrid = () => screen.getByRole('table', { name: 'Operation theatres' });
const rowOf = (grid: HTMLElement, first: string) =>
  within(grid)
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === first) as HTMLElement;

/** The hospital's clock is Asia/Kolkata: 04:00 UTC is 9:30 in the morning. */
const SEEDED_ROW = /9:30.*11:00/;
const seededRow = () =>
  within(surgeryGrid())
    .getAllByRole('row')
    .find((row) => SEEDED_ROW.test(within(row).queryAllByRole('cell')[0]?.textContent ?? ''));

const open = async () => {
  renderApp({ entry: '/theatre' });
  await screen.findByRole('heading', HEADING);
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: SEEDED_DAY } });
  await waitFor(() => expect(seededRow()).toBeDefined(), { timeout: 10_000 });
};

const fillBooking = async (theatre: string, surgeon: string, start = '09:30', end = '11:00') => {
  await userEvent.type(await screen.findByRole('combobox', { name: /^Patient/ }), 'MRN-PTH-00010');
  await userEvent.click(await screen.findByRole('option', { name: /MRN-PTH-00010/ }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Theatre/ }), theatre);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Surgeon/ }), surgeon);
  await userEvent.type(screen.getByRole('textbox', { name: /^Procedure/ }), 'Hernia repair');
  fireEvent.change(screen.getByLabelText(/^Starts/), { target: { value: start } });
  fireEvent.change(screen.getByLabelText(/^Ends/), { target: { value: end } });
};

describe('operation theatre', () => {
  it('lists the day of surgeries and the theatres', async () => {
    await open();
    // The row can be redrawn when the theatres' names arrive, so look it up again on each try.
    await waitFor(
      () => {
        const row = seededRow() as HTMLElement;
        expect(within(row).getByText('Appendicectomy')).toBeInTheDocument();
        expect(within(row).getByText('Theatre 1')).toBeInTheDocument();
        expect(within(row).getByText('Scheduled')).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
    // The theatres load on their own query, so wait for them on a loaded machine.
    await waitFor(
      () => expect(within(rowOf(roomGrid(), 'Theatre 2')).getByText('In use')).toBeInTheDocument(),
      { timeout: 10_000 },
    );
    await expectNoAxeViolations();
  }, 20_000);

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Operation theatre' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('shows another day empty', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2030-01-16' } });
    expect(await screen.findByText('No surgeries on this day.')).toBeInTheDocument();
  });

  it('says what the server refused: theatre, then surgeon, and books when both are free', async () => {
    await open();
    const surgeon = within(seededRow() as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? '')[3] as string;
    await userEvent.click(screen.getByRole('button', { name: 'Book a surgery' }));
    await fillBooking('Theatre 1', surgeon);
    await userEvent.click(screen.getByRole('button', { name: 'Book surgery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That theatre is booked');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Theatre/ }), 'Theatre 2');
    await userEvent.click(screen.getByRole('button', { name: 'Book surgery' }));
    expect(await screen.findByText('That surgeon is booked at that time.')).toBeInTheDocument();

    const other = within(screen.getByRole('combobox', { name: /^Surgeon/ }))
      .getAllByRole('option')
      .map((option) => option.textContent ?? '')
      .find((name) => name !== surgeon && name !== 'Choose a surgeon') as string;
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Surgeon/ }), other);
    await userEvent.click(screen.getByRole('button', { name: 'Book surgery' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Surgery booked.'));
    await waitFor(() =>
      expect(within(surgeryGrid()).getByText('Hernia repair')).toBeInTheDocument(),
    );
  }, 40_000);

  it('checks the end is after the start before asking the server', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Book a surgery' }));
    fireEvent.change(await screen.findByLabelText(/^Starts/), { target: { value: '11:00' } });
    fireEvent.change(screen.getByLabelText(/^Ends/), { target: { value: '10:00' } });
    await userEvent.click(screen.getByRole('button', { name: 'Book surgery' }));
    expect(await screen.findByText('The end must be after the start.')).toBeInTheDocument();
  }, 20_000);

  it('starts and completes a surgery, then offers nothing more', async () => {
    await open();
    await userEvent.click(
      within(seededRow() as HTMLElement).getByRole('button', { name: /Start surgery/ }),
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Surgery started'));
    await waitFor(() =>
      expect(within(seededRow() as HTMLElement).getByText('In progress')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        within(seededRow() as HTMLElement).getByRole('button', { name: /Complete surgery/ }),
      ).not.toHaveAttribute('aria-disabled', 'true'),
    );
    await userEvent.click(
      within(seededRow() as HTMLElement).getByRole('button', { name: /Complete surgery/ }),
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Surgery completed'));
    await waitFor(() =>
      expect(within(seededRow() as HTMLElement).getByText('Completed')).toBeInTheDocument(),
    );
  }, 30_000);

  it('cancels a surgery with a reason and frees the time', async () => {
    await open();
    await userEvent.click(
      within(seededRow() as HTMLElement).getByRole('button', { name: /Cancel surgery/ }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel surgery' }));
    expect(await screen.findAllByText(/required/i)).not.toHaveLength(0);
    await userEvent.type(screen.getByRole('textbox', { name: /Reason/ }), 'Patient unwell');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel surgery' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Surgery cancelled.'));
    await waitFor(() => expect(seededRow()).toBeUndefined());
  }, 30_000);

  it('adds a theatre and refuses a name that exists', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add a theatre' }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Theatre 1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    await userEvent.clear(screen.getByRole('textbox', { name: /^Name/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Theatre 3');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Theatre Theatre 3'));
    await waitFor(() => expect(rowOf(roomGrid(), 'Theatre 3')).toBeDefined());
  }, 30_000);

  it('says a surgery was changed by someone else first', async () => {
    await open();
    server.use(
      http.post('*/api/theatre/surgeries/:id/start', () =>
        HttpResponse.json(
          { error: { code: 'version_conflict', message: 'Changed', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(
      within(seededRow() as HTMLElement).getByRole('button', { name: /Start surgery/ }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this first');
  });
});

describe('access to the operation theatre', () => {
  it('is closed without theatre:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'theatre:read');
    renderApp({ entry: '/theatre' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Operation theatre' })).not.toBeInTheDocument();
  });

  it('offers no booking, moves or theatre changes without the permissions', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'surgery:schedule');
    revokePermission(TENANT_IDS.hospital, 'admin', 'surgery:perform');
    revokePermission(TENANT_IDS.hospital, 'admin', 'theatre:manage');
    await open();
    expect(screen.queryByRole('button', { name: 'Book a surgery' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a theatre' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start surgery/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reschedule/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rename/ })).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'theatre', false);
    renderApp({ entry: '/theatre' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Operation theatre' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('has no operation theatre at the clinic', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'theatre:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/theatre' });
    await screen.findByRole('heading', HEADING);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(screen.queryByRole('link', { name: 'Operation theatre' })).not.toBeInTheDocument();
  });
});
