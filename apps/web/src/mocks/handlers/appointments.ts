import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { dayBoundsUtc, todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDoctor } from './doctors';
import { mockPatient } from './patients';

type AppointmentSummary = components['schemas']['AppointmentSummary'];
type AppointmentPage = components['schemas']['AppointmentPage'];
type AppointmentStatus = components['schemas']['AppointmentStatus'];

const FEATURE_FLAG = 'appointments';
const READ = 'appointment:read';
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

const HOSPITAL = { tenantId: TENANT_IDS.hospital, timezone: 'Asia/Kolkata', patient: 'pth' };
const CLINIC = { tenantId: TENANT_IDS.clinic, timezone: 'Asia/Dubai', patient: 'ptc' };

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
    const today = todayIn(site.timezone, now);
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
            startsAt: zonedToUtc(day, start, site.timezone),
            endsAt: zonedToUtc(day, end, site.timezone),
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
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 25), 1), 100);
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
    const timezone = access.tenantId === CLINIC.tenantId ? CLINIC.timezone : HOSPITAL.timezone;
    const start = dayBoundsUtc(from, timezone).start;
    const end = dayBoundsUtc(to, timezone).end;
    const visible = appointments
      .filter((item) => item.tenantId === access.tenantId)
      .filter((item) => item.startsAt >= start && item.startsAt < end)
      .filter((item) => !doctorId || item.doctorId === doctorId)
      .filter((item) => !status || item.status === status)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
      .map(summaryOf)
      .filter((item): item is AppointmentSummary => item !== null);
    const first = cursor ? visible.findIndex((item) => item.id === cursor) : 0;
    if (first < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[first + limit];
    return HttpResponse.json<AppointmentPage>({
      items: visible.slice(first, first + limit),
      nextCursor: next ? next.id : null,
      // With the first page only, as the API gives it.
      ...(cursor ? {} : { total: visible.length }),
    });
  }),
];
