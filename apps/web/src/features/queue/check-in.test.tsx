import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  mockTenantTimezone,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { addMockAppointment } from '@/mocks/handlers/appointments';
import { addMockQueueToken, mockQueueToken } from '@/mocks/handlers/queue';
import { server } from '@/mocks/node';
import { nextDay, todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
const timezone = () => mockTenantTimezone(HOSPITAL);

/** An appointment of doc_h_02 (General Medicine is dep_h_02's) at a time of the hospital's day. */
function addAppointment(
  id: string,
  { day = todayIn(timezone()), status = 'scheduled' as const, patientId = 'pth_00002' } = {},
) {
  addMockAppointment({
    id,
    tenantId: HOSPITAL,
    patientId,
    doctorId: 'doc_h_02',
    // Late in the day, so it is still today whenever the test runs.
    startsAt: zonedToUtc(day, '23:30', timezone()),
    endsAt: zonedToUtc(day, '23:45', timezone()),
    status,
    version: 1,
  });
}

const openAppointment = async (id: string) => {
  renderApp({ entry: `/appointments/${id}` });
  await screen.findByRole('heading', { name: 'Appointment', level: 1 });
};

/** Every check-in sent, with its idempotency key. */
function watchCheckIns(): { key: string | null; body: unknown }[] {
  const seen: { key: string | null; body: unknown }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname.endsWith('/api/queue/check-ins')
    ) {
      void request
        .clone()
        .json()
        .then((body: unknown) => seen.push({ key: request.headers.get('Idempotency-Key'), body }));
    }
  });
  return seen;
}

// The time as the hospital's locale writes it.
const CHECK_IN = { name: /^Check in, appointment at (11|23):30/ };

describe('checking in a booked patient', () => {
  it('issues a token for the doctor from the appointment’s screen, and says so in place', async () => {
    const sent = watchCheckIns();
    addAppointment('apt_checkin_1');
    await openAppointment('apt_checkin_1');
    await userEvent.click(await screen.findByRole('button', CHECK_IN));

    const outcome = await screen.findByText(/^Checked in: token \d+, .+\.$/);
    expect(outcome).toHaveAttribute('role', 'status');
    expect(document.activeElement).toBe(outcome);
    expect(screen.queryByRole('button', CHECK_IN)).not.toBeInTheDocument();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      key: expect.stringMatching(/^[\w-]{8,}$/) as string,
      body: { appointmentId: 'apt_checkin_1' },
    });
    await expectNoAxeViolations();
  });

  it('gives the first token when the appointment is checked in again', async () => {
    addAppointment('apt_checkin_2');
    const first = renderApp({ entry: '/appointments/apt_checkin_2' });
    await userEvent.click(await screen.findByRole('button', CHECK_IN));
    const done = await screen.findByText(/^Checked in: token (\d+), /);
    const number = /token (\d+)/.exec(done.textContent ?? '')?.[1];
    first.unmount();

    await openAppointment('apt_checkin_2');
    await userEvent.click(await screen.findByRole('button', CHECK_IN));
    expect(
      await screen.findByText(new RegExp(`^Already checked in: token ${number}, `)),
    ).toBeInTheDocument();
  });

  it('checks in from a row of today’s appointments', async () => {
    renderApp({ entry: '/appointments' });
    const [first] = await screen.findAllByRole('button', { name: /^Check in, appointment at / });
    if (!first) throw new Error('no appointment to check in');
    await userEvent.click(first);
    expect(await screen.findByText(/^Checked in: token \d+, .+\.$/)).toHaveFocus();
  });

  it('says why a patient already in the department’s queue is refused', async () => {
    addAppointment('apt_checkin_4', { patientId: 'pth_00004' });
    addMockQueueToken({
      id: 'qt_walk_in',
      tenantId: HOSPITAL,
      departmentId: 'dep_h_02',
      patientId: 'pth_00004',
      status: 'waiting',
      issuedAt: new Date().toISOString(),
      callCount: 0,
      version: 1,
    });
    await openAppointment('apt_checkin_4');
    await userEvent.click(await screen.findByRole('button', CHECK_IN));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This patient already has a token in this department today.',
    );
    expect(mockQueueToken('qt_walk_in')).toBeDefined();
  });
});

describe('another hospital', () => {
  it('checks in at the clinic into the clinic’s own queue', async () => {
    const clinic = TENANT_IDS.clinic;
    const zone = mockTenantTimezone(clinic);
    addMockAppointment({
      id: 'apt_checkin_clinic',
      tenantId: clinic,
      patientId: 'ptc_00009',
      doctorId: 'doc_c_01',
      startsAt: zonedToUtc(todayIn(zone), '23:30', zone),
      endsAt: zonedToUtc(todayIn(zone), '23:45', zone),
      status: 'scheduled',
      version: 1,
    });
    signIn(USER_IDS.receptionist);
    await openAppointment('apt_checkin_clinic');
    await userEvent.click(await screen.findByRole('button', CHECK_IN));
    const done = await screen.findByText(/^Checked in: token (\d+), .+\.$/);
    const number = /token (\d+)/.exec(done.textContent ?? '')?.[1] ?? '';
    expect(mockQueueToken(`qt_${clinic}_dep_c_01_new_${number}`)).toMatchObject({
      tenantId: clinic,
      doctorId: 'doc_c_01',
      appointmentId: 'apt_checkin_clinic',
    });
  });
});

describe('when check-in is offered', () => {
  it('is not offered for an appointment of another day, or one no longer scheduled', async () => {
    addAppointment('apt_checkin_5', { day: nextDay(todayIn(timezone())) });
    await openAppointment('apt_checkin_5');
    expect(screen.queryByRole('button', { name: /^Check in/ })).not.toBeInTheDocument();
  });

  it('is not offered for a cancelled appointment', async () => {
    addMockAppointment({
      id: 'apt_checkin_6',
      tenantId: HOSPITAL,
      patientId: 'pth_00006',
      doctorId: 'doc_h_02',
      startsAt: zonedToUtc(todayIn(timezone()), '23:30', timezone()),
      endsAt: zonedToUtc(todayIn(timezone()), '23:45', timezone()),
      status: 'cancelled',
      cancellation: { reason: 'duplicate' },
      version: 2,
    });
    await openAppointment('apt_checkin_6');
    expect(screen.queryByRole('button', { name: /^Check in/ })).not.toBeInTheDocument();
  });

  it.each([['queue:create'], ['patient:read']])('is not offered without %s', async (permission) => {
    addAppointment('apt_checkin_7');
    revokePermission(HOSPITAL, 'admin', permission);
    await openAppointment('apt_checkin_7');
    await screen.findByText(/11:30/);
    expect(screen.queryByRole('button', { name: /^Check in/ })).not.toBeInTheDocument();
  });

  it('is not offered when the hospital has the queue switched off', async () => {
    addAppointment('apt_checkin_8');
    setTenantFeature(HOSPITAL, 'queue', false);
    await openAppointment('apt_checkin_8');
    await screen.findByText(/11:30/);
    expect(screen.queryByRole('button', { name: /^Check in/ })).not.toBeInTheDocument();
  });
});

describe('the list', () => {
  it('offers check-in only on today’s scheduled appointments', async () => {
    renderApp({ entry: '/appointments' });
    const grid = await screen.findByRole('table');
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBeGreaterThan(1));
    for (const button of within(grid).queryAllByRole('button', { name: /^Check in/ })) {
      expect(button.closest('tr')).toHaveTextContent('Scheduled');
    }
  });
});
