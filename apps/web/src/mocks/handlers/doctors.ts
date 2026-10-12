import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS, USER_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDepartment } from './departments';

type Doctor = components['schemas']['Doctor'];
type DoctorPage = components['schemas']['DoctorPage'];
type DoctorCandidate = components['schemas']['DoctorCandidate'];
type DoctorCandidatePage = components['schemas']['DoctorCandidatePage'];
type DoctorSession = components['schemas']['DoctorSession'];
type DoctorAvailability = components['schemas']['DoctorAvailability'];

const FEATURE_FLAG = 'doctors';
const READ = 'doctor:read';
const MANAGE = 'doctor:manage';

interface Staff extends DoctorCandidate {
  tenantId: string;
}

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Sana', 'Vikram', 'Zoya'];
const LAST = ['Sharma', 'Iyer', 'Khan', 'Nair', 'Patel', 'Reddy', 'Singh', 'Verma', 'Das'];
const SPECIALIZATIONS = ['General practice', 'Surgery', 'Paediatrics', 'Cardiology', 'Diagnostics'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Synthetic staff: names from two short lists, so every one is distinct and none is real. */
function staffOf(tenantId: string, prefix: string, domain: string, count: number): Staff[] {
  return Array.from({ length: count }, (_, index) => {
    const first = FIRST[index % FIRST.length] ?? 'Staff';
    const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Member';
    return {
      tenantId,
      userId: `${prefix}_${String(index + 1).padStart(2, '0')}`,
      name: `${first} ${last}`,
      email: `${first}.${last}@${domain}`.toLowerCase(),
      roleId: 'doctor',
    };
  });
}

interface State {
  staff: Staff[];
  doctors: Doctor[];
  hours: Map<string, { sessions: DoctorSession[]; version: number }>;
  created: number;
}

const WEEKDAY_MORNINGS: DoctorSession[] = DAYS.slice(0, 5).map((day) => ({
  day,
  start: '09:00',
  end: '13:00',
}));

function seed(): State {
  const hospital = staffOf(TENANT_IDS.hospital, 'stf_h', 'sample-hospital.test', 36);
  const clinic = staffOf(TENANT_IDS.clinic, 'stf_c', 'riverside-clinic.test', 3);
  const staff: Staff[] = [
    ...hospital,
    ...clinic,
    // The people who can sign in to the mock, at the hospitals they belong to.
    {
      tenantId: TENANT_IDS.hospital,
      userId: USER_IDS.admin,
      name: 'Sample Admin',
      email: 'admin@sample-hospital.test',
      roleId: 'admin',
    },
    ...[TENANT_IDS.hospital, TENANT_IDS.clinic].map((tenantId) => ({
      tenantId,
      userId: USER_IDS.doctor,
      name: 'Sample Doctor',
      email: 'doctor@sample-hospital.test',
      roleId: 'doctor',
    })),
    {
      tenantId: TENANT_IDS.clinic,
      userId: USER_IDS.receptionist,
      name: 'Sample Receptionist',
      email: 'reception@riverside-clinic.test',
      roleId: 'receptionist',
    },
  ];

  const profile = (member: Staff, id: string, departmentId: string, index: number): Doctor => ({
    id,
    tenantId: member.tenantId,
    userId: member.userId,
    name: member.name,
    departmentId,
    departmentName: mockDepartment(member.tenantId, departmentId)?.name ?? '',
    specialization: SPECIALIZATIONS[index % SPECIALIZATIONS.length] ?? 'General practice',
    consultationMinutes: 15,
    active: true,
    version: 1,
  });

  // More than one page at the hospital. Its last seven staff, the admin and the sample doctor
  // have no profile there, so there is someone to add.
  const doctors: Doctor[] = [
    ...hospital
      .slice(0, 28)
      .map((member, index) =>
        profile(
          member,
          `doc_h_${String(index + 1).padStart(2, '0')}`,
          `dep_h_${String((index % 28) + 1).padStart(2, '0')}`,
          index,
        ),
      ),
    {
      ...profile(hospital[28] as Staff, 'doc_h_old', 'dep_h_02', 0),
      active: false,
      version: 2,
    },
    profile(clinic[0] as Staff, 'doc_c_01', 'dep_c_01', 0),
    profile(staff.at(-2) as Staff, 'doc_c_02', 'dep_c_02', 2),
  ];
  const hours = new Map(
    doctors.map((doctor) => [doctor.id, { sessions: [...WEEKDAY_MORNINGS], version: 1 }]),
  );
  return { staff, doctors, hours, created: 0 };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** What another member of staff does meanwhile: changes a profile behind the open screen. */
export function editMockDoctor(id: string, changes: Partial<Doctor>): void {
  const doctor = state.doctors.find((candidate) => candidate.id === id);
  if (!doctor) throw new Error(`Unknown mock doctor: ${id}`);
  Object.assign(doctor, changes, { version: doctor.version + 1 });
}

/** The same for a doctor's working hours. */
export function editMockAvailability(id: string, sessions: DoctorSession[]): void {
  const hours = state.hours.get(id);
  if (!hours) throw new Error(`Unknown mock doctor: ${id}`);
  state.hours.set(id, { sessions, version: hours.version + 1 });
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const notFound = () => error(404, 'doctor_not_found', 'No such doctor');
const conflict = () => error(409, 'conflict', 'It has changed');

/** A doctor of another hospital does not exist as far as this session is concerned. */
const find = (tenantId: string, id: unknown) =>
  state.doctors.find((candidate) => candidate.id === id && candidate.tenantId === tenantId);

function paged<T>(request: Request, all: T[], idOf: (item: T) => string) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 100);
  const cursor = url.searchParams.get('cursor');
  const start = cursor ? all.findIndex((item) => idOf(item) === cursor) : 0;
  if (start < 0) return null;
  const next = all[start + limit];
  return {
    items: all.slice(start, start + limit),
    nextCursor: next ? idOf(next) : null,
    total: all.length,
  };
}

/** The profile fields of a body, checked as the API's schema would. Null when not acceptable. */
function readProfile(tenantId: string, body: Record<string, unknown>) {
  const fields: Partial<Doctor> = {};
  const { departmentId, specialization, registrationNumber, consultationMinutes, active } = body;
  if (departmentId !== undefined) {
    const department = typeof departmentId === 'string' && mockDepartment(tenantId, departmentId);
    if (!department) return null;
    fields.departmentId = department.id;
    fields.departmentName = department.name;
  }
  if (specialization !== undefined) {
    if (typeof specialization !== 'string' || !specialization.trim()) return null;
    if (specialization.length > 100) return null;
    fields.specialization = specialization.trim();
  }
  if (registrationNumber !== undefined) {
    if (typeof registrationNumber !== 'string' || registrationNumber.length > 50) return null;
    fields.registrationNumber = registrationNumber.trim();
  }
  if (consultationMinutes !== undefined) {
    if (!Number.isInteger(consultationMinutes)) return null;
    const minutes = consultationMinutes as number;
    if (minutes < 5 || minutes > 120) return null;
    fields.consultationMinutes = minutes;
  }
  if (active !== undefined) {
    if (typeof active !== 'boolean') return null;
    fields.active = active;
  }
  return fields;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

function validSessions(value: unknown): DoctorSession[] | null {
  if (!Array.isArray(value) || value.length > 42) return null;
  const sessions: DoctorSession[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { day, start, end } = item as Record<string, unknown>;
    const known = DAYS.find((candidate) => candidate === day);
    if (!known || typeof start !== 'string' || typeof end !== 'string') return null;
    if (!TIME.test(start) || !TIME.test(end) || end <= start) return null;
    sessions.push({ day: known, start, end });
  }
  sessions.sort(
    (a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start.localeCompare(b.start),
  );
  const overlap = sessions.some((session, index) => {
    const before = sessions[index - 1];
    return before !== undefined && before.day === session.day && session.start < before.end;
  });
  return overlap ? null : sessions;
}

export const doctorsHandlers = [
  // Before `/doctors/:doctorId`, which would otherwise take "candidates" for an id.
  http.get('*/api/doctors/candidates', ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase();
    const taken = new Set(
      state.doctors.filter((d) => d.tenantId === access.tenantId).map((d) => d.userId),
    );
    // Tenant isolation: only staff of the session's hospital are ever considered.
    const candidates = state.staff
      .filter((member) => member.tenantId === access.tenantId && !taken.has(member.userId))
      .filter((member) => `${member.name} ${member.email}`.toLowerCase().includes(q))
      .sort(byName)
      .map(({ userId, name, email, roleId }): DoctorCandidate => ({ userId, name, email, roleId }));
    const page = paged(request, candidates, (candidate) => candidate.userId);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<DoctorCandidatePage>(page);
  }),

  http.get('*/api/doctors', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const departmentId = params.get('departmentId');
    const active = params.get('active') !== 'false';
    const visible = state.doctors
      .filter((doctor) => doctor.tenantId === access.tenantId && doctor.active === active)
      .filter((doctor) => !departmentId || doctor.departmentId === departmentId)
      .filter((doctor) => `${doctor.name} ${doctor.specialization}`.toLowerCase().includes(q))
      .sort((a, b) => byName(a, b) || a.id.localeCompare(b.id));
    const page = paged(request, visible, (doctor) => doctor.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<DoctorPage>(page);
  }),

  http.post('*/api/doctors', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const fields = body && readProfile(access.tenantId, body);
    // A member of this hospital only: a user id from elsewhere is not a staff member here.
    const member = state.staff.find(
      (candidate) => candidate.tenantId === access.tenantId && candidate.userId === body?.userId,
    );
    if (!fields || !member || fields.active !== undefined) return invalid();
    const { departmentId, departmentName, specialization, consultationMinutes } = fields;
    if (!departmentId || !departmentName || !specialization || !consultationMinutes) {
      return invalid();
    }
    if (mockDepartment(access.tenantId, departmentId)?.archived) return invalid();
    if (state.doctors.some((d) => d.tenantId === access.tenantId && d.userId === member.userId)) {
      return error(409, 'doctor_exists', 'That staff member already has a profile');
    }
    const doctor: Doctor = {
      id: `doc_new_${++state.created}`,
      tenantId: access.tenantId,
      userId: member.userId,
      name: member.name,
      departmentId,
      departmentName,
      specialization,
      ...(fields.registrationNumber ? { registrationNumber: fields.registrationNumber } : {}),
      consultationMinutes,
      active: true,
      version: 1,
    };
    state.doctors.push(doctor);
    state.hours.set(doctor.id, { sessions: [], version: 1 });
    return HttpResponse.json<Doctor>(doctor, { status: 201 });
  }),

  http.get('*/api/doctors/:doctorId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const doctor = find(access.tenantId, params.doctorId);
    return doctor ? HttpResponse.json<Doctor>(doctor) : notFound();
  }),

  http.patch('*/api/doctors/:doctorId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const fields = body && readProfile(access.tenantId, body);
    if (!body || !fields || typeof body.expectedVersion !== 'number') return invalid();
    const doctor = find(access.tenantId, params.doctorId);
    if (!doctor) return notFound();
    if (doctor.version !== body.expectedVersion) return conflict();
    const before = JSON.stringify(doctor);
    Object.assign(doctor, fields);
    if (doctor.registrationNumber === '') delete doctor.registrationNumber;
    // Sending what the profile already has changes nothing.
    if (JSON.stringify(doctor) !== before) doctor.version += 1;
    return HttpResponse.json<Doctor>(doctor);
  }),

  http.get('*/api/doctors/:doctorId/availability', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const doctor = find(access.tenantId, params.doctorId);
    const hours = doctor && state.hours.get(doctor.id);
    if (!doctor || !hours) return notFound();
    return HttpResponse.json<DoctorAvailability>({ doctorId: doctor.id, ...hours });
  }),

  http.put('*/api/doctors/:doctorId/availability', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const sessions = validSessions(body?.sessions);
    if (!body || !sessions || typeof body.expectedVersion !== 'number') return invalid();
    const doctor = find(access.tenantId, params.doctorId);
    const hours = doctor && state.hours.get(doctor.id);
    if (!doctor || !hours) return notFound();
    if (hours.version !== body.expectedVersion) return conflict();
    const saved = { sessions, version: hours.version + 1 };
    state.hours.set(doctor.id, saved);
    return HttpResponse.json<DoctorAvailability>({ doctorId: doctor.id, ...saved });
  }),
];
