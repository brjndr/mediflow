import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import {
  acceptMockAppointmentExtension,
  addMockAppointment,
  mockAppointmentExtensions,
} from '@/mocks/handlers/appointments';
import { editMockAvailability, editMockDoctor } from '@/mocks/handlers/doctors';
import { server } from '@/mocks/node';
import { createRegistry, type FeatureManifest, type SlotProps } from '@/registry';
import { features } from '@/registry/features';
import { api, isApiError } from '@/shared/api';
import { TextField } from '@/shared/ui/form';
import { todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { createAppointment, fetchFreeSlots } from './api';
import { shiftDay } from './schemas';

const HEADING = { name: 'Book an appointment', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const HOSPITAL_TZ = 'Asia/Kolkata';
/** A doctor of the hospital with weekday mornings (09:00 to 13:00) and nothing booked. */
const DOCTOR = 'doc_h_10';
const PATIENT = 'pth_00001';

/**
 * A weekday eight to fourteen days ahead at the hospital: past the seeded appointments, and
 * every slot of the morning still to come, whatever the day the tests run.
 */
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

/** Every booking request the screen made: its body and idempotency key. */
function watchBookings(): { body: Record<string, unknown>; key: string | null }[] {
  const seen: { body: Record<string, unknown>; key: string | null }[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/api/appointments')) {
      const key = request.headers.get('Idempotency-Key');
      void request
        .clone()
        .json()
        .then((body: Record<string, unknown>) => seen.push({ body, key }));
    }
  });
  return seen;
}

const timeGroup = () => screen.getByRole('group', { name: /^Time/ });
const timeButtons = () => within(timeGroup()).queryAllByRole('button');
const pressed = () => timeButtons().filter((b) => b.getAttribute('aria-pressed') === 'true');

// The request listeners of one test never run in the next.
afterEach(() => {
  server.events.removeAllListeners();
});

const openBooking = async (options: Parameters<typeof renderApp>[0] = {}) => {
  const app = renderApp({ entry: '/appointments/new', ...options });
  await screen.findByRole('heading', HEADING);
  return app;
};

async function choosePatient() {
  await userEvent.type(screen.getByRole('combobox', { name: 'Patient' }), 'MRN-PTH-00001');
  await userEvent.click(await screen.findByRole('option', { name: /MRN-PTH-00001/ }));
  expect(await screen.findByRole('button', { name: 'Change patient' })).toBeInTheDocument();
}

async function chooseDoctorAndDay(day: string) {
  const doctor = screen.getByRole('combobox', { name: /^Doctor/ });
  await waitFor(() => expect(within(doctor).getAllByRole('option').length).toBeGreaterThan(1));
  await userEvent.selectOptions(doctor, DOCTOR);
  fireEvent.change(screen.getByLabelText(/^Day/), { target: { value: day } });
  // Four hours of fifteen-minute slots.
  await waitFor(() => expect(timeButtons()).toHaveLength(16));
}

const submit = () => userEvent.click(screen.getByRole('button', { name: 'Book' }));

describe('booking an appointment', () => {
  it('books a patient into a free time of the doctor, with an idempotency key', async () => {
    const seen = watchBookings();
    const day = bookableDay();
    const { router } = await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(day);
    const doctorName = (screen.getByRole('combobox', { name: /^Doctor/ }) as HTMLSelectElement)
      .selectedOptions[0]?.textContent;

    const [first] = timeButtons();
    await userEvent.click(first as HTMLElement);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    await userEvent.type(screen.getByLabelText(/^Reason/), '  Follow-up of a cough ');
    await submit();

    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(String(doctorName));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toMatch(/^[\w-]{8,}$/);
    // The patient and the slot by id and instant; nothing of a feature that added no field.
    expect(seen[0]?.body).toEqual({
      patientId: PATIENT,
      doctorId: DOCTOR,
      startsAt: at(day, '09:00'),
      reason: 'Follow-up of a cough',
    });

    // The time is no longer offered.
    const slots = await fetchFreeSlots({ doctorId: DOCTOR, day });
    expect(slots.slots.map((slot) => slot.startsAt)).not.toContain(at(day, '09:00'));

    await userEvent.click(screen.getByRole('link', { name: 'Back to the appointments' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/appointments'));
  });

  it('searches for the patient in a request body, never in an address', async () => {
    const addresses: string[] = [];
    server.events.on('request:start', ({ request }) => addresses.push(request.url));
    await openBooking();
    await choosePatient();
    expect(addresses.some((url) => url.endsWith('/api/patients/search'))).toBe(true);
    expect(addresses.every((url) => !url.includes('MRN-PTH'))).toBe(true);
  });

  it('is reached from the list', async () => {
    const { router } = renderApp({ entry: '/appointments' });
    await userEvent.click(await screen.findByRole('link', { name: 'Book an appointment' }));
    await screen.findByRole('heading', HEADING);
    expect(router.state.location.pathname).toBe('/appointments/new');
  });

  it('says what is missing, and sends nothing', async () => {
    const seen = watchBookings();
    await openBooking();
    await submit();

    expect(await screen.findByText('Choose the patient.')).toBeInTheDocument();
    expect(screen.getByText('Choose a doctor.')).toBeInTheDocument();
    expect(screen.getByText('Choose a time.')).toBeInTheDocument();
    expect(seen).toEqual([]);
  });

  it('lets go of the chosen time when the doctor or the day changes', async () => {
    const day = bookableDay();
    await openBooking();
    await chooseDoctorAndDay(day);
    await userEvent.click(timeButtons()[2] as HTMLElement);
    expect(timeButtons().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Doctor/ }), 'doc_h_11');
    await waitFor(() => expect(timeButtons()).toHaveLength(16));
    expect(timeButtons().some((b) => b.getAttribute('aria-pressed') === 'true')).toBe(false);
  });

  it('offers the next free times when someone else took the time first', async () => {
    const day = bookableDay();
    await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(day);
    await userEvent.type(screen.getByLabelText(/^Reason/), 'Fever');
    await userEvent.click(timeButtons()[0] as HTMLElement);

    // Another desk books the doctor at that time while this form is open.
    addMockAppointment({
      id: 'apt_other_desk',
      tenantId: TENANT_IDS.hospital,
      patientId: 'pth_00002',
      doctorId: DOCTOR,
      startsAt: at(day, '09:00'),
      endsAt: at(day, '09:15'),
      status: 'scheduled',
      version: 1,
    });
    await submit();

    // The next three free times are named, and the time taken is no longer offered.
    expect(
      await screen.findByText(/Someone booked that time a moment ago. The next free times are /),
    ).toBeInTheDocument();
    await waitFor(() => expect(timeButtons()).toHaveLength(15));
    expect(pressed()).toEqual([]);
    // What was typed stays.
    expect(screen.getByLabelText(/^Reason/)).toHaveValue('Fever');

    await userEvent.click(timeButtons()[0] as HTMLElement);
    await submit();
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeInTheDocument();
  });

  it('refuses a time when the patient is already booked then', async () => {
    const day = bookableDay();
    addMockAppointment({
      id: 'apt_patient_elsewhere',
      tenantId: TENANT_IDS.hospital,
      patientId: PATIENT,
      doctorId: 'doc_h_12',
      startsAt: at(day, '09:00'),
      endsAt: at(day, '09:15'),
      status: 'scheduled',
      version: 1,
    });
    await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(day);
    await userEvent.click(timeButtons()[0] as HTMLElement);
    await submit();

    expect(
      await screen.findByText(
        'This patient already has an appointment at this time. Choose another time.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appointment booked' })).not.toBeInTheDocument();
  });
});

describe('the server', () => {
  const body = (day: string, patientId = PATIENT) => ({
    patientId,
    doctorId: DOCTOR,
    startsAt: at(day, '10:00'),
  });

  it('lets only one of two simultaneous bookings of a time succeed', async () => {
    const day = bookableDay();
    const results = await Promise.allSettled([
      createAppointment(body(day), 'key-first-desk'),
      createAppointment(body(day, 'pth_00002'), 'key-other-desk'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect(isApiError(refused?.reason) && refused.reason.serverCode).toBe('slot_taken');
  });

  it('answers a repeat of a booking with the first result, not a second booking', async () => {
    const day = bookableDay();
    const first = await createAppointment(body(day), 'key-double-click');
    const again = await createAppointment(body(day), 'key-double-click');

    expect(again.id).toBe(first.id);
    const slots = await fetchFreeSlots({ doctorId: DOCTOR, day });
    expect(slots.slots).toHaveLength(15);
  });

  it('refuses a key used again for another booking', async () => {
    const day = bookableDay();
    await createAppointment(body(day), 'key-reused');
    await expect(createAppointment(body(day, 'pth_00002'), 'key-reused')).rejects.toMatchObject({
      serverCode: 'idempotency_key_reuse',
    });
  });

  it('refuses a time outside the doctor’s hours', async () => {
    const day = bookableDay();
    await expect(
      createAppointment({ ...body(day), startsAt: at(day, '14:00') }, 'key-afternoon'),
    ).rejects.toMatchObject({ serverCode: 'outside_hours' });
  });
});

describe('access', () => {
  it('offers no booking without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'appointment:create');
    renderApp({ entry: '/appointments' });
    await screen.findByRole('heading', { name: 'Appointments', level: 1 });
    expect(screen.queryByRole('link', { name: 'Book an appointment' })).not.toBeInTheDocument();
  });

  it('has no booking screen without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'appointment:create');
    renderApp({ entry: '/appointments/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('has no booking screen where the module is off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'appointments', false);
    renderApp({ entry: '/appointments/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    await expect(
      api.GET('/appointments/free-slots', {
        params: { query: { doctorId: DOCTOR, day: bookableDay() } },
      }),
    ).rejects.toMatchObject({ serverCode: 'feature_disabled' });
  });

  it('says why it cannot book where doctors are off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'doctors', false);
    await openBooking();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs the doctors module/);
    expect(screen.queryByRole('button', { name: 'Book' })).not.toBeInTheDocument();
  });

  it('says why it cannot book where patients are off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'patients', false);
    await openBooking();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs access to patient records/);
    expect(screen.queryByRole('button', { name: 'Book' })).not.toBeInTheDocument();
  });

  it('says why it cannot book for someone who may not read patients', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:read');
    await openBooking();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs access to patient records/);
    expect(screen.queryByRole('button', { name: 'Book' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('never books another hospital’s patient or doctor', async () => {
    signIn(USER_IDS.receptionist, TENANT_IDS.clinic);
    const day = bookableDay();
    // The clinic's doctor, the hospital's patient.
    await expect(
      createAppointment(
        { patientId: PATIENT, doctorId: 'doc_c_01', startsAt: at(day, '09:00') },
        'key-cross-patient',
      ),
    ).rejects.toMatchObject({ serverCode: 'unknown_patient' });
    // The clinic's patient, the hospital's doctor.
    await expect(
      createAppointment(
        { patientId: 'ptc_00001', doctorId: DOCTOR, startsAt: at(day, '09:00') },
        'key-cross-doctor',
      ),
    ).rejects.toMatchObject({ serverCode: 'unknown_doctor' });
    await expect(fetchFreeSlots({ doctorId: DOCTOR, day })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('the appointment.form.fields slot', () => {
  /** A feature that adds one field to the booking form, as a reminders module would. */
  const ReminderField = ({ context }: SlotProps) => (
    <TextField
      name="extensions.reminders.note"
      label={`Reminder note for ${String(context?.doctorId)}`}
    />
  );
  const reminders: FeatureManifest = {
    id: 'reminders',
    titleKey: 'title',
    i18n: { titles: { en: { title: 'Reminders' } }, load: () => Promise.resolve({ default: {} }) },
    featureFlag: 'appointments',
    routes: [],
    permissions: [],
    extensions: [
      {
        slot: 'appointment.form.fields',
        component: () => Promise.resolve({ default: ReminderField }),
      },
    ],
  };

  it('sends a contributed field under its feature id, given the doctor and the day', async () => {
    acceptMockAppointmentExtension('reminders');
    const seen = watchBookings();
    const day = bookableDay();
    await openBooking({ registry: createRegistry([...features, reminders]) });
    await choosePatient();
    await chooseDoctorAndDay(day);
    await userEvent.type(
      await screen.findByLabelText(`Reminder note for ${DOCTOR}`),
      'Call the day before',
    );
    await userEvent.click(timeButtons()[0] as HTMLElement);
    await submit();

    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeInTheDocument();
    const sent = seen[0]?.body;
    expect(sent?.extensions).toEqual({ reminders: { note: 'Call the day before' } });
    const [booked] = await api
      .GET('/appointments', { params: { query: { from: day, to: day, doctorId: DOCTOR } } })
      .then((result) => result.data?.items ?? []);
    expect(mockAppointmentExtensions(String(booked?.id))).toEqual({
      reminders: { note: 'Call the day before' },
    });
  });
});

describe('the booking form', () => {
  it('opens on the signed-in doctor’s own profile', async () => {
    editMockDoctor(DOCTOR, { userId: USER_IDS.doctor });
    grantPermission(TENANT_IDS.hospital, 'doctor', 'appointment:create');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openBooking();
    const doctor = screen.getByRole('combobox', { name: /^Doctor/ }) as HTMLSelectElement;
    await waitFor(() => expect(doctor.value).toBe(DOCTOR));
    expect(doctor.selectedOptions[0]?.textContent).toMatch(/\(you\)$/);
  });

  it('focuses the first field to fix after a failed submit, the patient first', async () => {
    await openBooking();
    const patient = screen.getByRole('combobox', { name: 'Patient' });
    // Required, as a screen reader says it: the patient box, and the group of times.
    expect(patient).toHaveAttribute('aria-required', 'true');
    expect(timeGroup()).toHaveAccessibleName('Time (required)');

    await submit();
    await waitFor(() => expect(patient).toHaveFocus());
    expect(patient).toHaveAccessibleDescription('Choose the patient.');
  });

  it('focuses the first free time when only the time is missing', async () => {
    await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(bookableDay());
    await submit();
    await waitFor(() => expect(timeButtons()[0]).toHaveFocus());
  });

  it('says the free times are loading and how many there are, without moving focus', async () => {
    await openBooking();
    const doctor = screen.getByRole('combobox', { name: /^Doctor/ });
    await waitFor(() => expect(within(doctor).getAllByRole('option').length).toBeGreaterThan(1));
    // Present before there is anything to say, so what is put in it is read.
    const status = within(timeGroup()).getByRole('status');
    await userEvent.selectOptions(doctor, DOCTOR);
    fireEvent.change(screen.getByLabelText(/^Day/), { target: { value: bookableDay() } });
    expect(status).toHaveTextContent('Loading the free times…');
    await waitFor(() => expect(status).toHaveTextContent('16 free times.'));
    expect(within(timeGroup()).getByRole('status')).toBe(status);
    expect(document.activeElement).not.toBe(status);
    await expectNoAxeViolations();
  });

  it('lets go of the chosen time when the day changes', async () => {
    const day = bookableDay();
    await openBooking();
    await chooseDoctorAndDay(day);
    await userEvent.click(timeButtons()[1] as HTMLElement);
    expect(pressed()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/^Day/), { target: { value: shiftDay(day, 7) } });
    await waitFor(() => expect(timeButtons()).toHaveLength(16));
    expect(pressed()).toEqual([]);
  });

  it('refuses a day it cannot book, without asking for its times', async () => {
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/free-slots')) asked.push(new URL(request.url).search);
    });
    await openBooking();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: /^Doctor/ }), DOCTOR);
    const tooFar = shiftDay(todayIn(HOSPITAL_TZ), 91);
    fireEvent.change(screen.getByLabelText(/^Day/), { target: { value: tooFar } });

    expect(
      within(timeGroup()).getByText('Choose a day from today to 90 days ahead.'),
    ).toBeInTheDocument();
    await submit();
    expect(await screen.findAllByText('Choose a day from today to 90 days ahead.')).toHaveLength(2);
    expect(asked.some((search) => search.includes(tooFar))).toBe(false);
  });

  it('says so when the time left the doctor’s hours meanwhile', async () => {
    const day = bookableDay();
    await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(day);
    await userEvent.click(timeButtons()[0] as HTMLElement);
    // The doctor's hours change behind the open form: the mornings now start at ten.
    editMockAvailability(
      DOCTOR,
      (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((weekday) => ({
        day: weekday,
        start: '10:00',
        end: '13:00',
      })),
    );
    await submit();

    expect(
      await screen.findByText(/no longer in the doctor's working hours. The next free times are/),
    ).toBeInTheDocument();
    await waitFor(() => expect(timeButtons()).toHaveLength(12));
  });

  it('does not show a refusal for a doctor chosen while the booking was on its way', async () => {
    const day = bookableDay();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(
        '*/api/appointments',
        async () => {
          await held;
          return HttpResponse.json(
            { error: { code: 'slot_taken', message: 'taken', requestId: 'req' } },
            { status: 409 },
          );
        },
        { once: true },
      ),
    );
    await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(day);
    await userEvent.click(timeButtons()[0] as HTMLElement);
    await submit();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Doctor/ }), 'doc_h_11');
    release();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Book' })).toBeEnabled());
    expect(screen.queryByText(/Someone booked that time/)).not.toBeInTheDocument();
  });

  it('sends the same key again after a network failure, so it cannot book twice', async () => {
    const seen = watchBookings();
    server.use(http.post('*/api/appointments', () => HttpResponse.error(), { once: true }));
    const day = bookableDay();
    await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(day);
    await userEvent.click(timeButtons()[0] as HTMLElement);
    await submit();
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await submit();
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeInTheDocument();
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]?.key).toBe(seen[0]?.key);
  });

  it('books another, keeping the doctor and the day', async () => {
    const day = bookableDay();
    await openBooking();
    await choosePatient();
    await chooseDoctorAndDay(day);
    await userEvent.type(screen.getByLabelText(/^Reason/), 'Fever');
    await userEvent.click(timeButtons()[0] as HTMLElement);
    await submit();
    await userEvent.click(await screen.findByRole('button', { name: 'Book another' }));

    const search = await screen.findByRole('combobox', { name: 'Patient' });
    expect(search).toHaveFocus();
    expect(screen.getByRole('combobox', { name: /^Doctor/ })).toHaveValue(DOCTOR);
    expect(screen.getByLabelText(/^Day/)).toHaveValue(day);
    expect(screen.getByLabelText(/^Reason/)).toHaveValue('');
    // The time just booked is no longer offered, and none is chosen.
    await waitFor(() => expect(timeButtons()).toHaveLength(15));
    expect(pressed()).toEqual([]);
  });

  it('works for a custom role given what booking needs', async () => {
    for (const permission of ['appointment:read', 'appointment:create', 'doctor:read']) {
      grantPermission(TENANT_IDS.clinic, 'billing_clerk', permission);
    }
    signIn(USER_IDS.billingClerk, TENANT_IDS.clinic);
    await openBooking();
    await userEvent.type(screen.getByRole('combobox', { name: 'Patient' }), 'MRN-PTC-00001');
    await userEvent.click(await screen.findByRole('option', { name: /MRN-PTC-00001/ }));
    expect(await screen.findByRole('button', { name: 'Change patient' })).toHaveFocus();
  });
});
