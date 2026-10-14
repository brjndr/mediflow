import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InfiniteData } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  revokePermission,
  setTenantFeature,
  signIn,
  switchTenant,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { addMockAppointment } from '@/mocks/handlers/appointments';
import { server } from '@/mocks/node';
import { createRegistry, type FeatureManifest, type SlotProps } from '@/registry';
import { features } from '@/registry/features';
import { isApiError } from '@/shared/api';
import { todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { renderApp } from '@/test/render';
import { changeAppointment, fetchAppointment } from './api';
import { appointmentKeys } from './hooks/use-appointments';
import { allowedChanges, cancelSchema } from './schemas';
import type { AppointmentPage } from './types';

const HOSPITAL_TZ = 'Asia/Kolkata';
const NO_ACCESS = { name: 'You do not have access to this page' };
/** A doctor of the hospital with weekday mornings (09:00 to 13:00) and nothing booked. */
const DOCTOR = 'doc_h_10';
const MINUTE = 60_000;

/** A weekday eight to fourteen days ahead at the hospital, every slot of its morning to come. */
function bookableDay(): string {
  const today = todayIn(HOSPITAL_TZ);
  for (let ahead = 8; ; ahead++) {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + ahead);
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5) return date.toISOString().slice(0, 10);
  }
}

const at = (day: string, time: string) => zonedToUtc(day, time, HOSPITAL_TZ);
const iso = (ms: number) => new Date(ms).toISOString();

/** Adds an appointment of the hospital with doctor `DOCTOR`, starting and ending as given. */
function addAppointment(
  id: string,
  startsAt: string,
  endsAt: string,
  extra: Partial<Parameters<typeof addMockAppointment>[0]> = {},
) {
  addMockAppointment({
    id,
    tenantId: TENANT_IDS.hospital,
    patientId: 'pth_00001',
    doctorId: DOCTOR,
    startsAt,
    endsAt,
    status: 'scheduled',
    version: 1,
    ...extra,
  });
}

/** One that started five minutes ago and has ten to go. */
const addStarted = (id = 'apt_started') =>
  addAppointment(id, iso(Date.now() - 5 * MINUTE), iso(Date.now() + 10 * MINUTE), {
    reason: 'Follow-up of the cough',
  });

/** One on a weekday a week or more ahead, at 09:00. */
const addAhead = (id = 'apt_ahead') => {
  const day = bookableDay();
  addAppointment(id, at(day, '09:00'), at(day, '09:15'));
  return day;
};

/** Every change request the screen made: its path, body and idempotency key. */
function watchChanges(): { path: string; body: Record<string, unknown>; key: string | null }[] {
  const seen: { path: string; body: Record<string, unknown>; key: string | null }[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (request.method === 'POST' && /\/api\/appointments\/[^/]+\/[\w-]+$/.test(url.pathname)) {
      const key = request.headers.get('Idempotency-Key');
      void request
        .clone()
        .json()
        .then((body: Record<string, unknown>) => seen.push({ path: url.pathname, body, key }));
    }
  });
  return seen;
}

/** The list's doctor filter, once its options are in. */
async function chooseDoctor() {
  const doctor = await screen.findByRole('combobox', { name: 'Doctor' });
  await waitFor(() => expect(within(doctor).queryAllByRole('option').length).toBeGreaterThan(1));
  await userEvent.selectOptions(doctor, DOCTOR);
}

afterEach(() => {
  server.events.removeAllListeners();
});

/** What the record says under a label, such as "Status". */
const valueOf = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? '';
const statusOf = () => valueOf('Status');

const openAppointment = async (id: string, options: Parameters<typeof renderApp>[0] = {}) => {
  const app = renderApp({ entry: `/appointments/${id}`, ...options });
  await screen.findByRole('heading', { name: 'Appointment', level: 1 });
  return app;
};

describe('which changes are offered', () => {
  const start = Date.parse('2026-10-14T04:00:00Z');
  const appointment = (status: 'scheduled' | 'completed' | 'cancelled' | 'no_show') => ({
    status,
    startsAt: iso(start),
    endsAt: iso(start + 15 * MINUTE),
  });

  it('moves or cancels one still to come, and completes it only once it starts', () => {
    expect(allowedChanges(appointment('scheduled'), start - MINUTE)).toEqual({
      reschedule: true,
      cancel: true,
      complete: false,
      noShow: false,
    });
    expect(allowedChanges(appointment('scheduled'), start)).toEqual({
      reschedule: true,
      cancel: true,
      complete: true,
      noShow: true,
    });
    // Ended: it was seen or not; it is no longer cancelled.
    expect(allowedChanges(appointment('scheduled'), start + 15 * MINUTE).cancel).toBe(false);
  });

  it('changes nothing about a completed, cancelled or missed appointment', () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      expect(Object.values(allowedChanges(appointment(status), start + MINUTE))).toEqual([
        false,
        false,
        false,
        false,
      ]);
    }
  });

  it('asks for a reason, and a note when the reason is other', () => {
    expect(cancelSchema.safeParse({ reason: '', note: '' }).success).toBe(false);
    expect(cancelSchema.safeParse({ reason: 'other', note: '  ' }).success).toBe(false);
    expect(cancelSchema.safeParse({ reason: 'other', note: 'Flooded road' }).success).toBe(true);
    expect(cancelSchema.safeParse({ reason: 'duplicate', note: '' }).success).toBe(true);
    // Text that prints as nothing is refused, as the API refuses it.
    expect(cancelSchema.safeParse({ reason: 'hospital', note: 'a​b' }).success).toBe(false);
  });
});

describe('the appointment screen', () => {
  it('is opened from a row of the list, and shows the reason for the visit', async () => {
    addStarted();
    const { router } = renderApp({ entry: '/appointments' });
    await screen.findByRole('heading', { name: 'Appointments', level: 1 });
    await chooseDoctor();
    const [open] = await screen.findAllByRole('button', { name: /^Open the appointment/ });
    await userEvent.click(open as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toBe('/appointments/apt_started'));
    expect(await screen.findByText('Follow-up of the cough')).toBeInTheDocument();
    expect(statusOf()).toBe('Scheduled');
  });

  it('offers moving and cancelling before the start, and completing once it starts', async () => {
    addAhead();
    await openAppointment('apt_ahead');
    expect(await screen.findByRole('button', { name: 'Move' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel the appointment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as completed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as no-show' })).not.toBeInTheDocument();
  });

  it('offers no change of a final status', async () => {
    addAppointment('apt_done', iso(Date.now() - 60 * MINUTE), iso(Date.now() - 45 * MINUTE), {
      status: 'completed',
    });
    await openAppointment('apt_done');
    await waitFor(() => expect(statusOf()).toBe('Completed'));
    expect(screen.queryByRole('button', { name: /^(Move|Cancel|Mark)/ })).not.toBeInTheDocument();
  });

  it('shows the change at once, in the list too, and keeps it when saved', async () => {
    addStarted();
    const seen = watchChanges();
    // Held until the test lets it through, so what is shown before the answer can be seen.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post('*/api/appointments/:id/complete', async () => {
        await gate;
        return undefined;
      }),
    );
    const { queryClient } = renderApp({ entry: '/appointments' });
    await chooseDoctor();
    const [open] = await screen.findAllByRole('button', { name: /^Open the appointment/ });
    await userEvent.click(open as HTMLElement);
    await screen.findByText('Follow-up of the cough');

    await userEvent.click(screen.getByRole('button', { name: 'Mark as completed' }));
    expect(screen.getByText(/was seen\. This cannot be undone\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as completed' }));

    await waitFor(() => expect(statusOf()).toBe('Completed'));
    const listed = queryClient
      .getQueriesData<InfiniteData<AppointmentPage>>({
        queryKey: appointmentKeys.lists(TENANT_IDS.hospital),
      })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? [])
      .filter((item) => item.id === 'apt_started');
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((item) => item.status === 'completed')).toBe(true);

    release();
    expect(await screen.findByText('The appointment was marked as completed.')).toBeInTheDocument();
    expect(statusOf()).toBe('Completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/api/appointments/apt_started/complete');
    expect(seen[0]?.body).toEqual({ version: 1 });
    expect(seen[0]?.key).toMatch(/^[\w-]{8,}$/);
    // Final now: nothing more is offered.
    expect(screen.queryByRole('button', { name: /^(Move|Cancel|Mark)/ })).not.toBeInTheDocument();
  });

  it('puts the status back when the server refuses, and says why', async () => {
    addStarted();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post('*/api/appointments/:id/no-show', async () => {
        await gate;
        return HttpResponse.json(
          { error: { code: 'invalid_transition', message: 'It is final', requestId: 'req_test' } },
          { status: 409 },
        );
      }),
    );
    await openAppointment('apt_started');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as no-show' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark as no-show' }));
    await waitFor(() => expect(statusOf()).toBe('No-show'));

    release();
    expect(await screen.findByText(/no longer scheduled, so it cannot be changed/)).toBeVisible();
    // The record is read again: still scheduled at the mock, so the status goes back.
    await waitFor(() => expect(statusOf()).toBe('Scheduled'));
  });

  it('says when someone changed it first, and shows it as saved', async () => {
    const day = addAhead();
    await openAppointment('apt_ahead');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the appointment' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Reason/ }), 'hospital');
    // Someone else moves it meanwhile.
    await changeAppointment(
      'apt_ahead',
      {
        kind: 'reschedule',
        body: { version: 1, doctorId: DOCTOR, startsAt: at(day, '10:00'), reason: 'hospital' },
      },
      'someone-else-1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the appointment' }));
    expect(await screen.findByText(/Someone changed this appointment meanwhile/)).toBeVisible();
    // The form is closed and the record read again: still scheduled, at the new time.
    expect(screen.queryByRole('combobox', { name: /^Reason/ })).not.toBeInTheDocument();
    expect(statusOf()).toBe('Scheduled');
    await waitFor(() => expect(valueOf('When')).toMatch(/10:00/));
  });

  it('says when the appointment was closed meanwhile', async () => {
    addStarted();
    await openAppointment('apt_started');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as completed' }));
    await changeAppointment(
      'apt_started',
      { kind: 'no_show', body: { version: 1 } },
      'someone-else-2',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mark as completed' }));
    expect(await screen.findByText(/no longer scheduled/)).toBeVisible();
    await waitFor(() => expect(statusOf()).toBe('No-show'));
  });

  it('cancels with a reason, and a note when the reason is other', async () => {
    addAhead();
    const seen = watchChanges();
    await openAppointment('apt_ahead');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the appointment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the appointment' }));
    expect(await screen.findByText('Choose a reason.')).toBeVisible();
    expect(seen).toHaveLength(0);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Reason/ }), 'other');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the appointment' }));
    expect(await screen.findByText('Say why, when the reason is "Other".')).toBeVisible();

    await userEvent.type(screen.getByRole('textbox', { name: /^Note/ }), 'Moved to another city');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the appointment' }));
    expect(await screen.findByText('The appointment was cancelled.')).toBeInTheDocument();
    await waitFor(() => expect(statusOf()).toBe('Cancelled'));
    expect(screen.getByText('Moved to another city')).toBeInTheDocument();
    expect(seen[0]?.body).toEqual({ version: 1, reason: 'other', note: 'Moved to another city' });
  });

  it('keeps the appointment when cancelling is given up', async () => {
    addAhead();
    const seen = watchChanges();
    await openAppointment('apt_ahead');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the appointment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.getByRole('button', { name: 'Move' })).toBeInTheDocument();
    expect(seen).toHaveLength(0);
    expect(statusOf()).toBe('Scheduled');
  });

  it('moves it to one of the free times, and offers the next ones when that is taken', async () => {
    const day = addAhead();
    const seen = watchChanges();
    await openAppointment('apt_ahead');
    await userEvent.click(await screen.findByRole('button', { name: 'Move' }));
    const times = await screen.findByRole('group', { name: /^Time/ });
    // Its own time is held by itself, so it is not offered.
    await waitFor(() => expect(within(times).getAllByRole('button').length).toBeGreaterThan(2));
    const [first, second] = within(times).getAllByRole('button');
    await userEvent.click(first as HTMLElement);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /^Reason/ }),
      'patient_request',
    );
    // Someone books that time first.
    addAppointment('apt_other', at(day, '09:15'), at(day, '09:30'), { patientId: 'pth_00002' });
    await userEvent.click(screen.getByRole('button', { name: 'Move to this time' }));
    expect(await screen.findByText(/Someone booked that time a moment ago/)).toBeVisible();

    const refreshed = within(screen.getByRole('group', { name: /^Time/ }));
    await waitFor(() =>
      expect(refreshed.getAllByRole('button')[0]?.textContent).toBe(second?.textContent),
    );
    await userEvent.click(refreshed.getAllByRole('button')[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Move to this time' }));
    expect(await screen.findByText('The appointment was moved.')).toBeInTheDocument();
    expect(seen.at(-1)?.body).toEqual({
      version: 1,
      doctorId: DOCTOR,
      startsAt: at(day, '09:30'),
      reason: 'patient_request',
    });
    expect(statusOf()).toBe('Scheduled');
  });

  it('moves an appointment for someone who may change but not book', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'appointment:create');
    addAhead();
    await openAppointment('apt_ahead');
    await userEvent.click(await screen.findByRole('button', { name: 'Move' }));
    const times = await screen.findByRole('group', { name: /^Time/ });
    await waitFor(() => expect(within(times).getAllByRole('button').length).toBeGreaterThan(0));
  });

  it('shows the record and offers no change without appointment:update', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'appointment:update');
    addStarted();
    await openAppointment('apt_started');
    expect(await screen.findByText('Follow-up of the cough')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Move|Cancel|Mark)/ })).not.toBeInTheDocument();
  });

  it('is not reachable without appointment:read, or with the module off', async () => {
    addStarted();
    revokePermission(TENANT_IDS.hospital, 'admin', 'appointment:read');
    const first = renderApp({ entry: '/appointments/apt_started' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    first.unmount();

    setTenantFeature(TENANT_IDS.hospital, 'appointments', false);
    renderApp({ entry: '/appointments/apt_started' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('never shows another hospital’s appointment', async () => {
    addStarted();
    signIn(USER_IDS.receptionist);
    renderApp({ entry: '/appointments/apt_started' });
    expect(await screen.findByText(/This appointment is not available/)).toBeVisible();
    expect(screen.queryByText('Follow-up of the cough')).not.toBeInTheDocument();
  });
});

describe('the rules, as the mock API enforces them', () => {
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return isApiError(error) ? error.serverCode : 'not an api error';
    }
    return 'accepted';
  };

  it('refuses completing before the start, and cancelling after the end', async () => {
    addAhead();
    addAppointment('apt_past', iso(Date.now() - 60 * MINUTE), iso(Date.now() - 45 * MINUTE));
    expect(
      await refusal(
        changeAppointment('apt_ahead', { kind: 'complete', body: { version: 1 } }, 'k-0000001'),
      ),
    ).toBe('too_early');
    expect(
      await refusal(
        changeAppointment(
          'apt_past',
          { kind: 'cancel', body: { version: 1, reason: 'hospital' } },
          'k-0000002',
        ),
      ),
    ).toBe('too_late');
  });

  it('changes a final status never, and an old version never', async () => {
    addStarted();
    await changeAppointment('apt_started', { kind: 'complete', body: { version: 1 } }, 'k-0000003');
    expect(
      await refusal(
        changeAppointment('apt_started', { kind: 'no_show', body: { version: 2 } }, 'k-0000004'),
      ),
    ).toBe('invalid_transition');
    addAhead('apt_ahead_2');
    expect(
      await refusal(
        changeAppointment(
          'apt_ahead_2',
          { kind: 'cancel', body: { version: 7, reason: 'hospital' } },
          'k-0000005',
        ),
      ),
    ).toBe('conflict');
  });

  it('returns the first answer to a repeated request', async () => {
    addStarted();
    const first = await changeAppointment(
      'apt_started',
      { kind: 'complete', body: { version: 1 } },
      'k-0000006',
    );
    const again = await changeAppointment(
      'apt_started',
      { kind: 'complete', body: { version: 1 } },
      'k-0000006',
    );
    expect(again).toEqual(first);
    expect(first.version).toBe(2);
  });

  it('answers another hospital’s appointment as one that does not exist', async () => {
    addStarted();
    signIn(USER_IDS.doctor);
    switchTenant(TENANT_IDS.clinic);
    expect(await refusal(fetchAppointment('apt_started'))).toBe('appointment_not_found');
    signIn(USER_IDS.receptionist);
    expect(
      await refusal(
        changeAppointment('apt_started', { kind: 'no_show', body: { version: 1 } }, 'k-0000007'),
      ),
    ).toBe('appointment_not_found');
  });
});

describe('the appointment.row.badges slot', () => {
  const Badge = ({ context }: SlotProps) => (
    <span>{`Badge for ${String(context?.appointmentId)}`}</span>
  );
  const badges: FeatureManifest = {
    id: 'badges',
    titleKey: 'title',
    i18n: { titles: { en: { title: 'Badges' } }, load: () => Promise.resolve({ default: {} }) },
    featureFlag: 'appointments',
    routes: [],
    permissions: [],
    extensions: [
      { slot: 'appointment.row.badges', component: () => Promise.resolve({ default: Badge }) },
    ],
  };

  it('draws a contribution on each row, given the appointment id alone', async () => {
    addStarted();
    renderApp({ entry: '/appointments', registry: createRegistry([...features, badges]) });
    await chooseDoctor();
    expect(await screen.findAllByText('Badge for apt_started')).not.toHaveLength(0);
  });
});
