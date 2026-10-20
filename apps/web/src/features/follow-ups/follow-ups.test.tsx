import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mockTenantTimezone,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockAppointment } from '@/mocks/handlers/appointments';
import { mockFollowUps, touchMockFollowUp } from '@/mocks/handlers/clinical';
import { mockDoctor } from '@/mocks/handlers/doctors';
import { mockPatient } from '@/mocks/handlers/patients';
import { server } from '@/mocks/node';
import { todayIn } from '@/shared/utils/timezone';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { shiftDay } from './schemas';

// Follow-ups (#88): set from the consultation, booked as a linked appointment from it or from the
// due list, and cancelled. The mock's hospital has one due follow-up, `fu_h_1` of pth_00002 with
// doc_h_02 (from the closed visit enc_h_2); the consultation enc_h_1 has none.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const LIST = { name: 'Follow-ups', level: 1 };
const PANEL = { name: 'Follow-up', level: 2 };
const NO_ACCESS = { name: 'You do not have access to this page' };

afterEach(() => server.events.removeAllListeners());

const today = () => todayIn(mockTenantTimezone(HOSPITAL));

/**
 * A weekday eight to fourteen days ahead at the hospital: past the seeded appointments, with every
 * morning slot free, whatever the day the tests run.
 */
function bookableDay(): string {
  for (let ahead = 8; ; ahead++) {
    const day = shiftDay(today(), ahead);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) return day;
  }
}

const timeGroup = () => screen.getByRole('group', { name: /^Time/ });
const timeButtons = () => within(timeGroup()).queryAllByRole('button');

/** Books the open booking form on a free weekday, at its first time. */
async function bookFirstTime() {
  fireEvent.change(screen.getByLabelText(/^Day/), { target: { value: bookableDay() } });
  await waitFor(() => expect(timeButtons().length).toBeGreaterThan(0));
  await userEvent.click(timeButtons()[0] as HTMLElement);
  await userEvent.click(screen.getByRole('button', { name: 'Book' }));
}

const panel = () => screen.getByRole('heading', PANEL).closest('section') as HTMLElement;

async function openConsultation() {
  renderApp({ entry: '/encounters/enc_h_1' });
  await screen.findByRole('heading', PANEL);
  return within(panel()).findByRole('heading', { name: 'Set a follow-up' });
}

describe('setting a follow-up from the consultation', () => {
  it(
    'asks the patient back in two weeks to the consultation’s doctor, said in words',
    { timeout: 15_000 },
    async () => {
      await openConsultation();
      expect(within(panel()).getByText('No follow-up set.')).toBeInTheDocument();
      await userEvent.click(within(panel()).getByRole('button', { name: 'In 14 days' }));
      expect(within(panel()).getByLabelText(/^Come back on/)).toHaveValue(shiftDay(today(), 14));
      await userEvent.type(
        within(panel()).getByRole('textbox', { name: /^Message for the desk/ }),
        'With the X-ray',
      );
      await userEvent.click(within(panel()).getByRole('button', { name: 'Set follow-up' }));

      expect(await within(panel()).findByRole('status')).toHaveTextContent('Follow-up set.');
      const doctor = mockDoctor(HOSPITAL, 'doc_h_01')?.name ?? '';
      expect(
        await within(panel()).findByText(new RegExp(`^Come back on .+ to ${doctor}$`)),
      ).toBeInTheDocument();
      expect(within(panel()).getByText('To book')).toBeInTheDocument();
      expect(within(panel()).getByText('With the X-ray')).toBeInTheDocument();
      expect(mockFollowUps().find((each) => each.encounterId === 'enc_h_1')).toMatchObject({
        dueOn: shiftDay(today(), 14),
        doctorId: 'doc_h_01',
        note: 'With the X-ray',
        state: 'due',
      });
      // One at a time: no second form.
      expect(within(panel()).queryByRole('heading', { name: 'Set a follow-up' })).toBeNull();
      await expectNoAxeViolations();
    },
  );

  it('refuses a day in the past or more than a year ahead on the form', async () => {
    const sent: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/follow-ups')) sent.push(request.url);
    });
    await openConsultation();
    const day = within(panel()).getByLabelText(/^Come back on/);
    fireEvent.change(day, { target: { value: shiftDay(today(), -1) } });
    await userEvent.click(within(panel()).getByRole('button', { name: 'Set follow-up' }));
    expect(
      await within(panel()).findByText('Choose a day from today to a year ahead.'),
    ).toBeInTheDocument();
    expect(day).toHaveFocus();
    fireEvent.change(day, { target: { value: shiftDay(today(), 400) } });
    await userEvent.click(within(panel()).getByRole('button', { name: 'Set follow-up' }));
    expect(
      within(panel()).getByText('Choose a day from today to a year ahead.'),
    ).toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it('books it now as an appointment it names, for someone who books appointments', async () => {
    await openConsultation();
    await userEvent.click(within(panel()).getByRole('button', { name: 'In 7 days' }));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Set follow-up' }));
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Book now' }));
    expect(await screen.findByRole('heading', { name: /^Book the follow-up of / })).toHaveFocus();
    await bookFirstTime();

    expect(await within(panel()).findByRole('status')).toHaveTextContent(/^Booked for .+ with /);
    const booked = mockFollowUps().find((each) => each.encounterId === 'enc_h_1');
    expect(booked?.state).toBe('booked');
    // The acceptance criterion: the follow-up creates a linked appointment of its patient.
    const appointment = mockAppointment(HOSPITAL, booked?.appointmentId ?? '');
    expect(appointment).toMatchObject({
      patientId: 'pth_00001',
      doctorId: 'doc_h_01',
      status: 'scheduled',
    });
    // The state says when, apart from the status line that said it was booked.
    expect(await within(panel()).findByText(/^Booked for [^w]+$/)).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Book now' })).toBeNull();
  });

  it('cancels a due follow-up with a reason, and then takes another', async () => {
    await openConsultation();
    await userEvent.click(within(panel()).getByRole('button', { name: 'Set follow-up' }));
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Cancel follow-up' }));
    await screen.findByRole('heading', { name: 'Cancel the follow-up' });
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Why the patient need not come back/ }),
      'Recovered',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel follow-up' }));
    expect(await within(panel()).findByRole('status')).toHaveTextContent('Follow-up cancelled.');
    expect(within(panel()).getByText(/^Cancelled: .+ Recovered$/)).toBeInTheDocument();
    expect(
      await within(panel()).findByRole('heading', { name: 'Set a follow-up' }),
    ).toBeInTheDocument();
  });

  it('shows the follow-up without setting one for followUp:read alone, and books nothing without appointment:create', async () => {
    revokePermission(HOSPITAL, 'admin', 'followUp:create');
    revokePermission(HOSPITAL, 'admin', 'appointment:create');
    renderApp({ entry: '/encounters/enc_h_2' });
    await screen.findByRole('heading', PANEL);
    expect(await within(panel()).findByText(/^Come back on /)).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Book now' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Cancel follow-up' })).toBeNull();
  });

  it('shows no trace of it without followUp:read', async () => {
    const reads: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET') reads.push(new URL(request.url).pathname);
    });
    revokePermission(HOSPITAL, 'admin', 'followUp:read');
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', { name: 'Consultation', level: 1 });
    await screen.findByRole('heading', { name: 'Referrals' });
    expect(screen.queryByRole('heading', PANEL)).toBeNull();
    expect(reads.some((path) => path.endsWith('/follow-ups'))).toBe(false);
  });
});

describe('the follow-up due list', () => {
  const grid = () => screen.getByRole('table', { name: 'Follow-ups' });

  it('lists what is still to book, and books one as an appointment', async () => {
    renderApp({ entry: '/follow-ups' });
    await screen.findByRole('heading', LIST);
    const patient = mockPatient(HOSPITAL, 'pth_00002')?.name ?? '';
    expect(await within(grid()).findByText(patient)).toBeInTheDocument();
    expect(within(grid()).getByText('To book')).toBeInTheDocument();
    expect(within(grid()).getByText('With the haemoglobin result')).toBeInTheDocument();
    // The MRN is masked in a list.
    expect(within(grid()).queryByText('MRN-PTH-00002')).toBeNull();
    await expectNoAxeViolations();

    await userEvent.click(within(grid()).getByRole('button', { name: /^Book: / }));
    expect(await screen.findByRole('heading', { name: /^Book the follow-up of / })).toHaveFocus();
    await bookFirstTime();
    expect(await screen.findByText(/^Booked for .+ with /)).toBeInTheDocument();
    // No longer to book: the list of those to book is empty.
    expect(await within(grid()).findByText('No follow-ups match.')).toBeInTheDocument();
    const booked = mockFollowUps().find((each) => each.id === 'fu_h_1');
    expect(booked?.state).toBe('booked');
    expect(mockAppointment(HOSPITAL, booked?.appointmentId ?? '')).toMatchObject({
      patientId: 'pth_00002',
      doctorId: 'doc_h_02',
    });
  });

  it('books again from the version read after a conflict, without reopening', async () => {
    renderApp({ entry: '/follow-ups' });
    await screen.findByRole('heading', LIST);
    await within(grid()).findByText('To book');
    await userEvent.click(within(grid()).getByRole('button', { name: /^Book: / }));
    await screen.findByRole('heading', { name: /^Book the follow-up of / });
    // Another desk changed it meanwhile.
    touchMockFollowUp('fu_h_1');
    await bookFirstTime();
    expect(
      await screen.findByText(
        'This follow-up changed meanwhile. It has been read again: choose the time again.',
      ),
    ).toBeInTheDocument();
    // The list read it again; the same panel now sends the newer version.
    await waitFor(() => expect(timeButtons().length).toBeGreaterThan(0));
    await userEvent.click(timeButtons()[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    expect(await screen.findByText(/^Booked for .+ with /)).toBeInTheDocument();
    expect(mockFollowUps().find((each) => each.id === 'fu_h_1')?.state).toBe('booked');
  });

  it('shows the booked ones when asked, and every state', async () => {
    renderApp({ entry: '/follow-ups' });
    await screen.findByRole('heading', LIST);
    await within(grid()).findByText('To book');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'Booked');
    expect(await within(grid()).findByText('No follow-ups match.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'All states');
    expect(await within(grid()).findByText('To book')).toBeInTheDocument();
  });

  it('offers no booking with the appointments module off', async () => {
    setTenantFeature(HOSPITAL, 'appointments', false);
    renderApp({ entry: '/follow-ups' });
    await screen.findByRole('heading', LIST);
    await within(grid()).findByText('To book');
    expect(within(grid()).queryByRole('button', { name: /^Book: / })).toBeNull();
  });

  it('gives the clinic’s desk its own list and the navigation entry, not the hospital’s', async () => {
    signIn(USER_IDS.receptionist, CLINIC);
    renderApp({ entry: '/follow-ups' });
    await screen.findByRole('heading', LIST);
    expect(screen.getByRole('link', { name: 'Follow-ups' })).toBeInTheDocument();
    // The desk reads no consultations.
    expect(screen.queryByRole('link', { name: 'Consultations' })).toBeNull();
    expect(await within(grid()).findByText('No follow-ups match.')).toBeInTheDocument();
    expect(within(grid()).queryByText('With the haemoglobin result')).toBeNull();
  });

  it('is unreachable without followUp:read, and with the clinical module off', async () => {
    revokePermission(HOSPITAL, 'admin', 'followUp:read');
    const app = renderApp({ entry: '/follow-ups' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Follow-ups' })).toBeNull();
    app.unmount();

    setTenantFeature(HOSPITAL, 'clinical', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/follow-ups' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});
