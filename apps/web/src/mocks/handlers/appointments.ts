import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { dayBoundsUtc, todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { currentSession, mockTenantTimezone, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDoctor, mockDoctorHours } from './doctors';
import { mockPatient } from './patients';

type AppointmentSummary = components['schemas']['AppointmentSummary'];
type AppointmentPage = components['schemas']['AppointmentPage'];
type AppointmentStatus = components['schemas']['AppointmentStatus'];
type Appointment = components['schemas']['Appointment'];
type FreeSlots = components['schemas']['FreeSlots'];

const FEATURE_FLAG = 'appointments';
const READ = 'appointment:read';
const CREATE = 'appointment:create';
const STATUSES: AppointmentStatus[] = ['scheduled', 'completed', 'cancelled', 'no_show'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;

/**
 * What the mock keeps: ids, never names. A name is looked up when a page is answered, as the API
 * joins it, so renaming a patient or a doctor shows at once and the seeds of the three mocks do
 * not depend on the order they run in.
 */
interface StoredAppointment {
  id: string;
  tenantId: string;
  patientId: string;
  doctorId: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  version: number;
}

const HOSPITAL = { tenantId: TENANT_IDS.hospital, patient: 'pth' };
const CLINIC = { tenantId: TENANT_IDS.clinic, patient: 'ptc' };

/** The calendar day this many days from another, counted at UTC noon so no day is skipped. */
const shiftDay = (day: string, by: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
};

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/**
 * Synthetic appointments around today at each hospital, deterministic for a given day: at the
 * hospital, six doctors with a morning of fifteen-minute appointments from three days ago to a
 * week ahead (more than a page a day); at the clinic, two doctors with a few each. Days gone by
 * are mostly completed, with some no-shows and cancellations.
 */
function seed(now = new Date()): StoredAppointment[] {
  const all: StoredAppointment[] = [];
  const plan = [
    {
      site: HOSPITAL,
      doctors: ['doc_h_01', 'doc_h_02', 'doc_h_03', 'doc_h_04', 'doc_h_05', 'doc_h_06'],
      perDoctor: 8,
      patients: 12_000,
    },
    { site: CLINIC, doctors: ['doc_c_01', 'doc_c_02'], perDoctor: 3, patients: 40 },
  ];
  for (const { site, doctors, perDoctor, patients } of plan) {
    const timezone = mockTenantTimezone(site.tenantId);
    const today = todayIn(timezone, now);
    let n = 0;
    for (let offset = -3; offset <= 7; offset++) {
      const day = shiftDay(today, offset);
      doctors.forEach((doctorId, d) => {
        for (let slot = 0; slot < perDoctor; slot++) {
          n += 1;
          const minutes = 9 * 60 + slot * 15;
          const start = `${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}`;
          const end = `${pad(Math.floor((minutes + 15) / 60), 2)}:${pad((minutes + 15) % 60, 2)}`;
          const past = offset < 0;
          const status: AppointmentStatus =
            n % 11 === 0
              ? 'cancelled'
              : past
                ? n % 7 === 0
                  ? 'no_show'
                  : 'completed'
                : 'scheduled';
          all.push({
            id: `apt_${site.tenantId}_${pad(n, 5)}`,
            tenantId: site.tenantId,
            patientId: `${site.patient}_${pad(((n * 37 + d) % patients) + 1, 5)}`,
            doctorId,
            startsAt: zonedToUtc(day, start, timezone),
            endsAt: zonedToUtc(day, end, timezone),
            status,
            version: 1,
          });
        }
      });
    }
  }
  return all;
}

let appointments = seed();
onMockReset(() => {
  appointments = seed();
});

/** Adds an appointment, for tests: one of another hospital, or one at a moment a test needs. */
export function addMockAppointment(appointment: StoredAppointment): void {
  appointments.push(appointment);
}

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

function summaryOf(stored: StoredAppointment): AppointmentSummary | null {
  const patient = mockPatient(stored.tenantId, stored.patientId);
  const doctor = mockDoctor(stored.tenantId, stored.doctorId);
  if (!patient || !doctor) return null;
  return {
    id: stored.id,
    tenantId: stored.tenantId,
    patientId: patient.id,
    patientName: patient.name,
    patientMrn: patient.mrn,
    doctorId: doctor.id,
    doctorName: doctor.name,
    ...(doctor.departmentName ? { departmentName: doctor.departmentName } : {}),
    startsAt: stored.startsAt,
    endsAt: stored.endsAt,
    status: stored.status,
    version: stored.version,
  };
}

export const appointmentsHandlers = [
  http.get('*/api/appointments', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    const doctorId = params.get('doctorId');
    const status = params.get('status');
    const limit = Number(params.get('limit') ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return error(400, 'validation_failed', 'Bad limit');
    }
    const cursor = params.get('cursor');
    if (!DAY.test(from) || !DAY.test(to)) return error(400, 'validation_failed', 'Bad days');
    const span = days(from, to);
    if (Number.isNaN(span) || span < 0 || span >= MAX_RANGE_DAYS) {
      return error(400, 'validation_failed', 'The days are not a range the list allows');
    }
    if (status !== null && !STATUSES.includes(status as AppointmentStatus)) {
      return error(400, 'validation_failed', 'Unknown status');
    }
    // The hospital's own days, in its own timezone: the session's tenant, never the request's.
    const timezone = mockTenantTimezone(access.tenantId);
    const start = dayBoundsUtc(from, timezone).start;
    const end = dayBoundsUtc(to, timezone).end;
    const visible = appointments
      .filter((item) => item.tenantId === access.tenantId)
      .filter((item) => item.startsAt >= start && item.startsAt < end)
      .filter((item) => !doctorId || item.doctorId === doctorId)
      .filter((item) => !status || item.status === status)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    const first = cursor ? visible.findIndex((item) => item.id === cursor) : 0;
    if (first < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[first + limit];
    return HttpResponse.json<AppointmentPage>({
      // Names are looked up for the page only.
      items: visible
        .slice(first, first + limit)
        .map(summaryOf)
        .filter((item): item is AppointmentSummary => item !== null),
      nextCursor: next ? next.id : null,
      // With the first page only, as the API gives it.
      ...(cursor ? {} : { total: visible.length }),
    });
  }),
];

/** How far ahead free slots are offered, as the API does. */
const BOOK_AHEAD_DAYS = 90;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
// Control characters and anything that prints as nothing, which the API refuses (a line break
// is allowed in a reason).
const UNPRINTABLE = /[^\P{Cc}\n]|\p{Cf}/u;

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const timeOf = (minutes: number) => `${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}`;

interface Slot {
  startsAt: string;
  endsAt: string;
}

/**
 * Every slot of a doctor's working hours on a day at the hospital that has not started yet,
 * booked or not, cut into the doctor's consultation length. A day before today or too far
 * ahead has none.
 */
function workingSlots(tenantId: string, doctorId: string, day: string, now = new Date()): Slot[] {
  const doctor = mockDoctor(tenantId, doctorId);
  if (!doctor?.active) return [];
  const length = doctor.consultationMinutes;
  const timezone = mockTenantTimezone(tenantId);
  const ahead = days(todayIn(timezone, now), day);
  if (Number.isNaN(ahead) || ahead < 0 || ahead > BOOK_AHEAD_DAYS) return [];
  const weekday = WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
  const slots: Slot[] = [];
  for (const session of mockDoctorHours(tenantId, doctorId).filter((s) => s.day === weekday)) {
    const end = minutesOf(session.end);
    for (let start = minutesOf(session.start); start + length <= end; start += length) {
      const startsAt = zonedToUtc(day, timeOf(start), timezone);
      if (Date.parse(startsAt) <= now.getTime()) continue;
      slots.push({ startsAt, endsAt: zonedToUtc(day, timeOf(start + length), timezone) });
    }
  }
  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Whether a scheduled appointment holds the time. Cancelled and no-show ones free it. */
const holds = (item: StoredAppointment, tenantId: string, slot: Slot) =>
  item.tenantId === tenantId &&
  item.status === 'scheduled' &&
  item.startsAt < slot.endsAt &&
  slot.startsAt < item.endsAt;

const doctorBusy = (tenantId: string, doctorId: string, slot: Slot) =>
  appointments.some((item) => item.doctorId === doctorId && holds(item, tenantId, slot));

const patientBusy = (tenantId: string, patientId: string, slot: Slot) =>
  appointments.some((item) => item.patientId === patientId && holds(item, tenantId, slot));

/**
 * Bookings already made, by tenant, user and idempotency key, with the body they were made
 * with, as the API keeps them: a retry returns the first result, and the same key with another
 * body is refused.
 */
let bookings = new Map<string, { body: string; record: Appointment }>();
let booked = 0;
/** Feature ids whose booking fields the mock accepts, as the API accepts registered ones. */
const extensionFeatures = new Set<string>();
/** What was sent in `extensions` with each booking, by appointment id, for tests to read. */
let bookedExtensions = new Map<string, Record<string, unknown>>();
onMockReset(() => {
  bookings = new Map();
  booked = 0;
  bookedExtensions = new Map();
  extensionFeatures.clear();
});

/** For tests: the mock accepts this feature's part of `extensions`, as if it had a schema. */
export function acceptMockAppointmentExtension(featureId: string): void {
  extensionFeatures.add(featureId);
}

/** For tests: what was sent in `extensions` with a booking. */
export const mockAppointmentExtensions = (id: string) => bookedExtensions.get(id);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validBooking(body: unknown): body is {
  patientId: string;
  doctorId: string;
  startsAt: string;
  reason?: string;
  extensions?: Record<string, Record<string, unknown>>;
} {
  if (!isObject(body)) return false;
  const { patientId, doctorId, startsAt, reason, extensions } = body;
  if (typeof patientId !== 'string' || typeof doctorId !== 'string') return false;
  if (typeof startsAt !== 'string' || Number.isNaN(Date.parse(startsAt))) return false;
  if (reason !== undefined) {
    if (typeof reason !== 'string' || reason.length > 500 || UNPRINTABLE.test(reason)) return false;
  }
  if (extensions !== undefined) {
    if (!isObject(extensions) || !Object.values(extensions).every(isObject)) return false;
  }
  return true;
}

export const bookingHandlers = [
  http.get('*/api/appointments/free-slots', ({ request }) => {
    const access = authorize(request, { permission: CREATE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const day = params.get('day') ?? '';
    const doctorId = params.get('doctorId') ?? '';
    if (!DAY.test(day) || doctorId === '') return error(400, 'validation_failed', 'Bad query');
    const doctor = mockDoctor(access.tenantId, doctorId);
    if (!doctor?.active) return error(404, 'not_found', 'No such doctor');
    return HttpResponse.json<FreeSlots>({
      doctorId: doctor.id,
      day,
      slotMinutes: doctor.consultationMinutes,
      slots: workingSlots(access.tenantId, doctor.id, day).filter(
        (slot) => !doctorBusy(access.tenantId, doctor.id, slot),
      ),
    });
  }),

  http.post('*/api/appointments', async ({ request }) => {
    const access = authorize(request, { permission: CREATE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body: unknown = await request.json().catch(() => null);
    // From here to the push nothing waits, so two requests are decided one after the other, as
    // the database's exclusion constraint decides between them in the API.
    const keyOf = `${access.tenantId}:${currentSession()?.user.id ?? ''}:${key}`;
    const replay = bookings.get(keyOf);
    if (replay) {
      if (replay.body !== JSON.stringify(body)) {
        return error(422, 'idempotency_key_reuse', 'This key was used for a different request');
      }
      return HttpResponse.json<Appointment>(replay.record, { status: 201 });
    }
    if (!validBooking(body)) return error(400, 'validation_failed', 'Some details are not valid');
    const extensions = body.extensions ?? {};
    if (Object.keys(extensions).some((id) => !extensionFeatures.has(id))) {
      return error(422, 'unknown_extension', 'A part of extensions belongs to no feature');
    }
    const { tenantId } = access;
    if (!mockPatient(tenantId, body.patientId)) {
      return error(422, 'unknown_patient', 'No such patient');
    }
    const doctor = mockDoctor(tenantId, body.doctorId);
    if (!doctor?.active) return error(422, 'unknown_doctor', 'No such doctor');
    const startsAt = new Date(body.startsAt).toISOString();
    const day = todayIn(mockTenantTimezone(tenantId), new Date(startsAt));
    const slot = workingSlots(tenantId, doctor.id, day).find((s) => s.startsAt === startsAt);
    if (!slot) return error(422, 'outside_hours', 'Not a slot of the working hours');
    if (doctorBusy(tenantId, doctor.id, slot)) {
      return error(409, 'slot_taken', 'The doctor is booked at that time');
    }
    if (patientBusy(tenantId, body.patientId, slot)) {
      return error(409, 'patient_overlap', 'The patient is booked at that time');
    }
    booked += 1;
    const stored: StoredAppointment = {
      id: `apt_${tenantId}_new_${pad(booked, 4)}`,
      tenantId,
      patientId: body.patientId,
      doctorId: doctor.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status: 'scheduled',
      version: 1,
    };
    appointments.push(stored);
    bookedExtensions.set(stored.id, extensions);
    const reason = body.reason?.trim() ?? '';
    const record: Appointment = {
      ...(summaryOf(stored) as AppointmentSummary),
      ...(reason ? { reason } : {}),
    };
    bookings.set(keyOf, { body: JSON.stringify(body), record });
    return HttpResponse.json<Appointment>(record, { status: 201 });
  }),
];
