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
type CancelReason = components['schemas']['AppointmentCancelReason'];

const FEATURE_FLAG = 'appointments';
const READ = 'appointment:read';
const CREATE = 'appointment:create';
const UPDATE = 'appointment:update';
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
  reason?: string;
  cancellation?: { reason: CancelReason; note?: string };
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

/** One appointment of a hospital, for the queue's check-in (#376). */
export const mockAppointment = (tenantId: string, id: string) =>
  appointments.find((appointment) => appointment.id === id && appointment.tenantId === tenantId);

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

/** The whole record: the list fields, the reason for the visit and why it was cancelled. */
function recordOf(stored: StoredAppointment): Appointment | null {
  const summary = summaryOf(stored);
  if (!summary) return null;
  return {
    ...summary,
    ...(stored.reason ? { reason: stored.reason } : {}),
    ...(stored.cancellation ? { cancellation: { ...stored.cancellation } } : {}),
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

/** `except`: an appointment being moved, whose own old time never counts against it. */
const doctorBusy = (tenantId: string, doctorId: string, slot: Slot, except?: string) =>
  appointments.some(
    (item) => item.id !== except && item.doctorId === doctorId && holds(item, tenantId, slot),
  );

const patientBusy = (tenantId: string, patientId: string, slot: Slot, except?: string) =>
  appointments.some(
    (item) => item.id !== except && item.patientId === patientId && holds(item, tenantId, slot),
  );

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
    // Asked for to book, or to move a booking.
    let access = authorize(request, { permission: CREATE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) {
      const update = authorize(request, { permission: UPDATE, featureFlag: FEATURE_FLAG });
      if ('denied' in update) return access.denied;
      access = update;
    }
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
    const reason = body.reason?.trim() ?? '';
    if (reason) stored.reason = reason;
    appointments.push(stored);
    bookedExtensions.set(stored.id, extensions);
    const record = recordOf(stored) as Appointment;
    bookings.set(keyOf, { body: JSON.stringify(body), record });
    return HttpResponse.json<Appointment>(record, { status: 201 });
  }),
];

const CANCEL_REASONS: CancelReason[] = [
  'patient_request',
  'doctor_unavailable',
  'hospital',
  'duplicate',
  'other',
];
const RESCHEDULE_REASONS = ['patient_request', 'doctor_unavailable', 'hospital', 'other'];

/** Changes already made, by tenant, user, appointment and idempotency key, as bookings are. */
let changes = new Map<string, { body: string; record: Appointment }>();
onMockReset(() => {
  changes = new Map();
});

/** A note: plain text, required when the reason is `other`. */
const validNote = (reason: unknown, note: unknown) =>
  note === undefined
    ? reason !== 'other'
    : typeof note === 'string' &&
      note.length <= 500 &&
      !UNPRINTABLE.test(note) &&
      (reason !== 'other' || note.trim() !== '');

type Kind = 'reschedule' | 'cancel' | 'complete' | 'no-show';

const FIELDS: Record<Kind, string[]> = {
  reschedule: ['version', 'doctorId', 'startsAt', 'reason', 'note'],
  cancel: ['version', 'reason', 'note'],
  complete: ['version'],
  'no-show': ['version'],
};

function validChange(
  kind: Kind,
  body: unknown,
): body is Record<string, unknown> & { version: number } {
  if (!isObject(body) || !Number.isInteger(body.version)) return false;
  if (Object.keys(body).some((field) => !FIELDS[kind].includes(field))) return false;
  if (kind === 'cancel') {
    return (
      CANCEL_REASONS.includes(body.reason as CancelReason) && validNote(body.reason, body.note)
    );
  }
  if (kind === 'reschedule') {
    return (
      typeof body.doctorId === 'string' &&
      typeof body.startsAt === 'string' &&
      !Number.isNaN(Date.parse(body.startsAt)) &&
      RESCHEDULE_REASONS.includes(body.reason as string) &&
      validNote(body.reason, body.note)
    );
  }
  return true;
}

/**
 * A change of an appointment, decided by the rules the API enforces: only a scheduled one
 * changes, from its current version; it is cancelled before it ends, completed or marked a
 * no-show once it starts, and moved to a free slot of a doctor. Nothing is awaited between the
 * checks and the write.
 */
const changeHandler = (kind: Kind) =>
  http.post(`*/api/appointments/:appointmentId/${kind}`, async ({ request, params }) => {
    const access = authorize(request, { permission: UPDATE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body: unknown = await request.json().catch(() => null);
    const { tenantId } = access;
    // Another hospital's appointment is answered as one that does not exist.
    const stored = appointments.find(
      (item) => item.id === params.appointmentId && item.tenantId === tenantId,
    );
    if (!stored) return error(404, 'appointment_not_found', 'No such appointment');
    const keyOf = `${tenantId}:${currentSession()?.user.id ?? ''}:${stored.id}:${key}`;
    const replay = changes.get(keyOf);
    if (replay) {
      if (replay.body !== JSON.stringify(body)) {
        return error(422, 'idempotency_key_reuse', 'This key was used for a different request');
      }
      return HttpResponse.json<Appointment>(replay.record);
    }
    if (!validChange(kind, body)) {
      return error(400, 'validation_failed', 'Some details are not valid');
    }
    if (stored.status !== 'scheduled') {
      return error(409, 'invalid_transition', `A ${stored.status} appointment does not change`);
    }
    if (body.version !== stored.version) return error(409, 'conflict', 'It has changed');
    const now = Date.now();
    if (kind === 'cancel') {
      if (now >= Date.parse(stored.endsAt)) return error(422, 'too_late', 'It has ended');
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      stored.status = 'cancelled';
      stored.cancellation = { reason: body.reason as CancelReason, ...(note ? { note } : {}) };
    } else if (kind === 'complete' || kind === 'no-show') {
      if (now < Date.parse(stored.startsAt)) return error(422, 'too_early', 'It has not started');
      stored.status = kind === 'complete' ? 'completed' : 'no_show';
    } else {
      const doctor = mockDoctor(tenantId, body.doctorId as string);
      if (!doctor?.active) return error(422, 'unknown_doctor', 'No such doctor');
      const startsAt = new Date(body.startsAt as string).toISOString();
      const day = todayIn(mockTenantTimezone(tenantId), new Date(startsAt));
      const slot = workingSlots(tenantId, doctor.id, day).find((s) => s.startsAt === startsAt);
      if (!slot) return error(422, 'outside_hours', 'Not a slot of the working hours');
      if (doctorBusy(tenantId, doctor.id, slot, stored.id)) {
        return error(409, 'slot_taken', 'The doctor is booked at that time');
      }
      if (patientBusy(tenantId, stored.patientId, slot, stored.id)) {
        return error(409, 'patient_overlap', 'The patient is booked at that time');
      }
      stored.doctorId = doctor.id;
      stored.startsAt = slot.startsAt;
      stored.endsAt = slot.endsAt;
    }
    stored.version += 1;
    const record = recordOf(stored) as Appointment;
    changes.set(keyOf, { body: JSON.stringify(body), record });
    return HttpResponse.json<Appointment>(record);
  });

/** After the booking handlers: `/appointments/free-slots` is not an appointment's id. */
export const appointmentChangeHandlers = [
  http.get('*/api/appointments/:appointmentId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const stored = appointments.find(
      (item) => item.id === params.appointmentId && item.tenantId === access.tenantId,
    );
    const record = stored ? recordOf(stored) : null;
    if (!record) return error(404, 'appointment_not_found', 'No such appointment');
    return HttpResponse.json<Appointment>(record);
  }),
  changeHandler('reschedule'),
  changeHandler('cancel'),
  changeHandler('complete'),
  changeHandler('no-show'),
];
