import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { addMockAppointment } from '@/mocks/handlers/appointments';
import { editMockDoctor } from '@/mocks/handlers/doctors';
import { server } from '@/mocks/node';
import { addDays, visibleDays, weekStartFor } from '@/shared/ui/calendar/zoned';
import { todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { appointmentKeys } from './hooks/use-appointments';

const HEADING = { name: 'Appointments', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const HOSPITAL_TZ = 'Asia/Kolkata';
const HOSPITAL_LOCALE = 'en-IN';
/** An appointment's own screen, by id. */
const APPOINTMENT_PATH = /^\/appointments\/apt_\w+$/;

const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const calendar = () => screen.getByRole('region', { name: 'Appointments calendar' });
/** The appointment blocks drawn on the calendar. */
const blocks = () => [...calendar().querySelectorAll<HTMLElement>('.rbc-event')];
/** The day headings drawn, in order. */
const headings = () =>
  [...calendar().querySelectorAll('.rbc-time-header .rbc-header')].map(
    (heading) => heading.textContent ?? '',
  );

/** Every request the calendar made, as the server saw its address. */
function watchRequests(): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/appointments')) seen.push(url.searchParams);
  });
  return seen;
}

/** The mock seeds eight appointments a doctor, each day from three days ago to a week ahead. */
function seededInWeek(today: string): number {
  const { from } = visibleDays('week', today, weekStartFor(HOSPITAL_LOCALE));
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const day = addDays(from, i);
    if (day >= addDays(today, -3) && day <= addDays(today, 7)) count += 8;
  }
  return count;
}

/** Below desktop width, as a phone or a tablet held upright. */
function narrowWindow() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const today = () => todayIn(HOSPITAL_TZ);

/** One of the six doctors with appointments every morning (the calendar opens on the first by name). */
const chooseDoctor = async (id = 'doc_h_01') => {
  const doctor = await screen.findByRole('combobox', { name: 'Doctor' });
  await waitFor(() => expect(within(doctor).queryAllByRole('option').length).toBeGreaterThan(0));
  await userEvent.selectOptions(doctor, id);
};

const openCalendar = async () => {
  const app = renderApp({ entry: '/appointments/calendar' });
  await screen.findByRole('heading', HEADING);
  await chooseDoctor();
  await waitFor(() => expect(blocks().length).toBeGreaterThan(0));
  return app;
};

describe('the appointment calendar', () => {
  it('opens on this week, and asks for that week alone', async () => {
    const seen = watchRequests();
    await openCalendar();

    const week = visibleDays('week', today(), weekStartFor(HOSPITAL_LOCALE));
    const expected = seededInWeek(today());
    await waitFor(() => expect(statuses()).toContain(`${expected} appointments`));
    expect(blocks()).toHaveLength(expected);
    expect(seen.length).toBeGreaterThan(0);
    for (const params of seen.filter((asked) => asked.get('doctorId') === 'doc_h_01')) {
      expect(params.get('from')).toBe(week.from);
      expect(params.get('to')).toBe(week.to);
      expect(params.has('status')).toBe(false);
    }
  });

  it('is reached from the list, and goes back to it', async () => {
    renderApp({ entry: '/appointments' });
    await userEvent.click(await screen.findByRole('link', { name: 'Calendar' }));
    expect(await screen.findByRole('region', { name: 'Appointments calendar' })).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'List' }));
    expect(await screen.findByRole('table', { name: 'Appointments' })).toBeInTheDocument();
  });

  it('shows one day, and moves a day or a week at a time', async () => {
    const seen = watchRequests();
    await openCalendar();
    await userEvent.click(screen.getByRole('button', { name: 'Day' }));
    await waitFor(() => expect(statuses()).toContain('8 appointments'));
    expect(seen.at(-1)?.get('from')).toBe(today());
    expect(seen.at(-1)?.get('to')).toBe(today());

    await userEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(seen.at(-1)?.get('from')).toBe(addDays(today(), 1)));
    await waitFor(() => expect(statuses()).toContain('8 appointments'));

    await userEvent.click(screen.getByRole('button', { name: 'Week' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    const lastWeek = visibleDays('week', addDays(today(), -6), weekStartFor(HOSPITAL_LOCALE));
    await waitFor(() => expect(seen.at(-1)?.get('from')).toBe(lastWeek.from));

    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(statuses()).toContain(`${seededInWeek(today())} appointments`));
  });

  it('draws an appointment at the hospital’s time, whatever the browser’s timezone', async () => {
    const previous = process.env.TZ;
    // Ten and a half hours behind the hospital: its morning is the browser's evening before.
    process.env.TZ = 'America/New_York';
    try {
      // The browser's clock is behind UTC now, unlike the hospital's.
      expect(new Date().getTimezoneOffset()).toBeGreaterThan(0);
      addMockAppointment({
        id: 'apt_late',
        tenantId: TENANT_IDS.hospital,
        patientId: 'pth_00001',
        doctorId: 'doc_h_01',
        startsAt: zonedToUtc(today(), '18:30', HOSPITAL_TZ),
        endsAt: zonedToUtc(today(), '18:45', HOSPITAL_TZ),
        status: 'scheduled',
        version: 1,
      });
      await openCalendar();
      await userEvent.click(screen.getByRole('button', { name: 'Day' }));
      await waitFor(() => expect(statuses()).toContain('9 appointments'));
      const late = blocks().find((block) => /6:30\s?pm/i.test(block.textContent ?? ''));
      expect(late).toBeDefined();
      expect(late?.textContent).toMatch(/6:45\s?pm/i);
      // The morning is the morning at the hospital, not the browser's.
      expect(blocks().some((block) => /^9:00\s?am/i.test(block.textContent ?? ''))).toBe(true);
    } finally {
      process.env.TZ = previous;
    }
  });

  it('says the status in words, and opens the appointment by id', async () => {
    const { router } = await openCalendar();
    // A tooltip stays in the page after a hover: it holds the time and the status, never a name.
    for (const block of blocks()) {
      expect(block.getAttribute('title')).toMatch(/: (Scheduled|Completed|Cancelled|No-show)$/);
    }
    expect(
      blocks().some((block) => /\((Cancelled|Completed|No-show)\)/.test(block.textContent ?? '')),
    ).toBe(true);
    await userEvent.click(blocks()[0] as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toMatch(APPOINTMENT_PATH));
  });

  it('opens an appointment from the keyboard', async () => {
    const { router } = await openCalendar();
    (blocks()[0] as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toMatch(APPOINTMENT_PATH));
  });

  it('opens the appointment for someone who may not read patients', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:read');
    const { router } = await openCalendar();
    await userEvent.click(blocks()[0] as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toMatch(APPOINTMENT_PATH));
  });

  it('starts the week on the hospital’s first day, and draws seven days', async () => {
    await openCalendar();
    // The hospital's locale is en-IN: its week starts on Sunday, in every browser.
    const drawn = headings();
    expect(drawn).toHaveLength(7);
    expect(drawn[0]).toMatch(/^Sun/);
    const { from } = visibleDays('week', today(), 0);
    expect(drawn[0]).toContain(String(Number(from.slice(8))));
  });

  it('never draws one doctor’s appointments under another’s name', async () => {
    await openCalendar();
    server.use(
      http.get('*/api/appointments', async () => {
        await delay('infinite');
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    await chooseDoctor('doc_h_02');
    await waitFor(() => expect(blocks()).toHaveLength(0));
    expect(statuses()).toContain('Loading appointments…');
  });

  it('opens on the first doctor by name for someone with no profile here', async () => {
    const seen = watchRequests();
    renderApp({ entry: '/appointments/calendar' });
    const doctor = (await screen.findByRole('combobox', { name: 'Doctor' })) as HTMLSelectElement;
    await waitFor(() => expect(doctor.options.length).toBeGreaterThan(0));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(doctor.value).toBe(doctor.options[0]?.value);
    expect(new Set(seen.map((params) => params.get('doctorId')))).toEqual(new Set([doctor.value]));
  });

  it('draws a busy week in full', async () => {
    const week = visibleDays('week', today(), 0);
    server.use(
      http.get('*/api/appointments', () =>
        HttpResponse.json({
          // Five days of forty ten-minute appointments, from eight in the morning.
          items: Array.from({ length: 200 }, (_, i) => {
            const day = addDays(week.from, 1 + Math.floor(i / 40));
            const minutes = 8 * 60 + (i % 40) * 10;
            const at = (m: number) =>
              `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
            return {
              id: `apt_busy_${i}`,
              tenantId: TENANT_IDS.hospital,
              patientId: 'pth_00001',
              patientName: `Patient ${i}`,
              patientMrn: 'MRN-PTH-00001',
              doctorId: 'doc_h_01',
              doctorName: 'Doctor',
              startsAt: zonedToUtc(day, at(minutes), HOSPITAL_TZ),
              endsAt: zonedToUtc(day, at(minutes + 10), HOSPITAL_TZ),
              status: 'scheduled',
              version: 1,
            };
          }),
          nextCursor: null,
        }),
      ),
    );
    renderApp({ entry: '/appointments/calendar' });
    await chooseDoctor();
    await waitFor(() => expect(statuses()).toContain('200 appointments'));
    expect(blocks()).toHaveLength(200);
  });

  it('has no accessibility violations in the day and the week', async () => {
    await openCalendar();
    await expectNoAxeViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Day' }));
    await waitFor(() => expect(statuses()).toContain('8 appointments'));
    await chooseDoctor('doc_h_02');
    await waitFor(() => expect(statuses()).toContain('8 appointments'));
    expect(within(calendar()).queryAllByRole('columnheader')).toEqual([]);
    await expectNoAxeViolations();
  });

  it('says so when the server fails, and tries again', async () => {
    server.use(
      http.get('*/api/appointments', () =>
        HttpResponse.json({ code: 'internal', message: 'down' }, { status: 500 }),
      ),
    );
    renderApp({ entry: '/appointments/calendar' });
    await chooseDoctor();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    server.resetHandlers();
    await userEvent.click(retry);
    await waitFor(() => expect(blocks().length).toBeGreaterThan(0));
  });

  it('says when a range holds more than it shows', async () => {
    server.use(
      http.get('*/api/appointments', ({ request }) => {
        const cursor = Number(new URL(request.url).searchParams.get('cursor') ?? 0);
        const start = zonedToUtc(today(), '09:00', HOSPITAL_TZ);
        return HttpResponse.json({
          items: Array.from({ length: 100 }, (_, i) => ({
            id: `apt_many_${cursor + i}`,
            tenantId: TENANT_IDS.hospital,
            patientId: 'pth_00001',
            patientName: 'Many',
            patientMrn: 'MRN-PTH-00001',
            doctorId: 'doc_h_01',
            doctorName: 'Doctor',
            startsAt: start,
            endsAt: start,
            status: 'scheduled',
            version: 1,
          })),
          nextCursor: String(cursor + 100),
        });
      }),
    );
    const seen = watchRequests();
    renderApp({ entry: '/appointments/calendar' });
    expect(await screen.findByText(/More than 500 appointments on these days/)).toBeInTheDocument();
    // Five pages and no more.
    expect(seen).toHaveLength(5);
  });
});

describe('at phone and tablet width', () => {
  it('shows the day, and offers no week', async () => {
    narrowWindow();
    const seen = watchRequests();
    renderApp({ entry: '/appointments/calendar' });
    await chooseDoctor();
    await waitFor(() => expect(statuses()).toContain('8 appointments'));
    expect(screen.queryByRole('button', { name: 'Week' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeInTheDocument();
    expect(seen.every((params) => params.get('from') === params.get('to'))).toBe(true);
  });
});

describe('a doctor', () => {
  it('opens on their own calendar', async () => {
    editMockDoctor('doc_h_03', { userId: USER_IDS.doctor });
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const seen = watchRequests();
    renderApp({ entry: '/appointments/calendar' });
    const doctor = (await screen.findByRole('combobox', { name: 'Doctor' })) as HTMLSelectElement;
    await waitFor(() => expect(doctor.selectedOptions[0]?.textContent).toMatch(/\(you\)$/));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    // Never another doctor's first, while it was not yet known whose to show.
    expect(new Set(seen.map((params) => params.get('doctorId')))).toEqual(new Set(['doc_h_03']));
  });
});

describe('access', () => {
  it('has no screen without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'appointment:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/appointments/calendar' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'appointments', false);
    renderApp({ entry: '/appointments/calendar' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('says what is missing where doctors are off, and asks for nothing', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'doctors', false);
    const seen = watchRequests();
    renderApp({ entry: '/appointments/calendar' });
    expect(
      await screen.findByText(/choosing a doctor is not available to you/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Appointments calendar' })).not.toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s appointments in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient } = await openCalendar();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: appointmentKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(
      queryClient.getQueryCache().findAll({ queryKey: appointmentKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await userEvent.click(await screen.findByRole('link', { name: 'Appointments' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Calendar' }));
    await waitFor(() => expect(blocks().length).toBeGreaterThan(0));
    // Everything drawn is the clinic's.
    const drawn = queryClient
      .getQueryCache()
      .findAll({ queryKey: appointmentKeys.all(TENANT_IDS.clinic) })
      .flatMap(
        (query) =>
          (query.state.data as { items?: { tenantId: string }[] } | undefined)?.items ?? [],
      );
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((item) => item.tenantId === TENANT_IDS.clinic)).toBe(true);
    // The clinic's own doctors only.
    const doctor = screen.getByRole('combobox', { name: 'Doctor' }) as HTMLSelectElement;
    expect([...doctor.options].every((option) => option.value.startsWith('doc_c_'))).toBe(true);
  });
});
