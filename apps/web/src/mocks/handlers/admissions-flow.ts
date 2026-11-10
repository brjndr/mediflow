import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockNotesOf } from './clinical';
import { mockDepartment } from './departments';
import { mockDoctor, mockDoctorOfUser } from './doctors';
import { mockPatient } from './patients';
import { mockBoardBeds, setMockBedStatus } from './wards';

type Admission = components['schemas']['Admission'];
type AdmissionPage = components['schemas']['AdmissionPage'];
type Stay = components['schemas']['BedStay'];
type Stored = Admission & { key?: string; stays?: Stay[] };

const FEATURE_FLAG = 'admissions';
const TYPES = ['planned', 'emergency', 'transfer_in'];

/** Admissions made here, newest first, and who sits in a bed they gave (bed id to patient id). */
let admissions: Stored[] = [];
let sittingIn = new Map<string, string>();
let counter = 0;
let announce: (tenantId: string, wardId: string) => void = () => undefined;

onMockReset(() => {
  admissions = [];
  sittingIn = new Map();
  counter = 0;
});

/** Wires the board's event stream in, so a change of bed is heard by open boards. */
export function announceBedsWith(listener: (tenantId: string, wardId: string) => void): void {
  announce = listener;
}

/** Who a bed given by an admission here holds, or undefined for the seeded beds. */
export const mockBedPatient = (bedId: string): string | undefined => sittingIn.get(bedId);

type Bed = ReturnType<typeof mockBoardBeds>[number];

/** Gives the bed to the patient, freeing the one they leave. Undefined when it is not free. */
function takeBed(tenantId: string, bedId: string, patientId: string, leaving?: string) {
  const bed = mockBoardBeds(tenantId).find((candidate) => candidate.id === bedId);
  if (!bed || bed.status !== 'available') return undefined;
  setMockBedStatus(bed.id, 'occupied');
  sittingIn.set(bed.id, patientId);
  announce(tenantId, bed.wardId);
  const old = leaving ? mockBoardBeds(tenantId).find((each) => each.id === leaving) : undefined;
  if (old) {
    setMockBedStatus(old.id, 'cleaning');
    sittingIn.delete(old.id);
    announce(tenantId, old.wardId);
  }
  return bed;
}

function bedOf(bed: Bed): NonNullable<Admission['bed']> {
  return {
    assignmentId: `asg_${bed.id}_${counter}`,
    bedId: bed.id,
    bedNumber: bed.number,
    wardId: bed.wardId,
    wardName: bed.wardName,
    roomName: bed.roomName,
    assignedAt: new Date().toISOString(),
  };
}

function shown(stored: Stored): Admission {
  const { key: _key, stays: _stays, ...admission } = stored;
  return admission;
}

/** Closes the stay in the bed being left and opens one in the new bed. */
function recordStay(
  stored: Stored,
  bed: Bed,
  leaving: boolean,
  why: { moveReason?: Stay['moveReason']; moveNote?: string } = {},
) {
  const stays = stored.stays ?? [];
  const now = new Date().toISOString();
  const open = stays.find((stay) => stay.releasedAt === undefined);
  if (open) {
    open.releasedAt = now;
    open.releaseReason = leaving ? 'transfer' : 'discharge';
  }
  stays.push({
    assignmentId: `asg_${bed.id}_${stays.length}`,
    bedId: bed.id,
    bedNumber: bed.number,
    wardId: bed.wardId,
    wardName: bed.wardName,
    bedCategoryId: bed.categoryName,
    ...(bed.dayPriceMinor === undefined ? {} : { dayPriceMinor: bed.dayPriceMinor }),
    assignedAt: now,
    ...why,
  });
  stored.stays = stays;
}

/**
 * Admits a patient from the emergency department, as the admissions API does for a disposition
 * (ER-02): an admission of type `emergency` without a bed, under the caller's doctor profile.
 * Gives the admission's id, or the code the API refuses with.
 */
export function admitMockFromEmergency(
  tenantId: string,
  patientId: string,
  adviceNote?: string,
  doctorId?: string,
): { id: string } | { code: 'already_admitted' | 'unknown_doctor' | 'unknown_patient' } {
  const patient = mockPatient(tenantId, patientId);
  if (!patient) return { code: 'unknown_patient' };
  const doctor = doctorId
    ? mockDoctor(tenantId, doctorId)
    : mockDoctorOfUser(tenantId, currentSession()?.user.id ?? '');
  if (!doctor) return { code: 'unknown_doctor' };
  if (
    admissions.some(
      (each) =>
        each.tenantId === tenantId && each.patientId === patientId && each.status === 'admitted',
    )
  ) {
    return { code: 'already_admitted' };
  }
  counter += 1;
  admissions.unshift({
    id: `adm_${counter}`,
    tenantId,
    patientId,
    patientName: patient.name,
    patientMrn: patient.mrn,
    encounterId: `enc_adm_${counter}`,
    doctorId: doctor.id,
    doctorName: doctor.name,
    departmentId: doctor.departmentId,
    departmentName: mockDepartment(tenantId, doctor.departmentId)?.name ?? '',
    admissionType: 'emergency',
    status: 'admitted',
    admittedAt: new Date().toISOString(),
    ...(adviceNote ? { adviceNote } : {}),
    consents: [],
    version: 1,
  });
  return { id: `adm_${counter}` };
}

export const admissionFlowHandlers = [
  http.get('*/api/admissions/:admissionId', ({ request, params }) => {
    const access = authorize(request, { permission: 'admission:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const admission = admissions.find(
      (each) => each.id === params.admissionId && each.tenantId === access.tenantId,
    );
    if (!admission) return error(404, 'admission_not_found', 'No such admission');
    return HttpResponse.json({ admission: shown(admission), stays: admission.stays ?? [] });
  }),

  http.get('*/api/admissions', ({ request }) => {
    const access = authorize(request, { permission: 'admission:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const status = query.get('status');
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const wardId = query.get('wardId');
    const all = admissions.filter(
      (admission) =>
        admission.tenantId === access.tenantId &&
        (!status || admission.status === status) &&
        (!wardId || admission.bed?.wardId === wardId),
    );
    const start = cursor ? all.findIndex((admission) => admission.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    return HttpResponse.json<AdmissionPage>({
      items: all.slice(start, start + limit).map(shown),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: all.length }),
    });
  }),

  http.post('*/api/admissions', async ({ request }) => {
    const access = authorize(request, {
      permission: 'admission:create',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const repeat = admissions.find((admission) => admission.key === key);
    if (repeat) return HttpResponse.json(shown(repeat), { status: 201 });
    const body = (await request.json().catch(() => null)) as {
      patientId?: unknown;
      admissionType?: unknown;
      doctorId?: unknown;
      bedId?: unknown;
      adviceNote?: unknown;
      attendantName?: unknown;
      attendantRelation?: unknown;
      attendantPhone?: unknown;
      depositMinor?: unknown;
      consents?: unknown;
    } | null;
    if (
      !body ||
      typeof body.patientId !== 'string' ||
      typeof body.admissionType !== 'string' ||
      !TYPES.includes(body.admissionType)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const patient = mockPatient(access.tenantId, body.patientId);
    if (!patient) return error(404, 'patient_not_found', 'No such patient');
    const doctor =
      typeof body.doctorId === 'string'
        ? mockDoctor(access.tenantId, body.doctorId)
        : mockDoctorOfUser(access.tenantId, currentSession()?.user.id ?? '');
    if (!doctor) return error(422, 'unknown_doctor', 'No such doctor');
    const already = admissions.some(
      (admission) =>
        admission.tenantId === access.tenantId &&
        admission.patientId === patient.id &&
        admission.status === 'admitted',
    );
    if (already) return error(409, 'already_admitted', 'Already admitted');
    let bed: Bed | undefined;
    if (typeof body.bedId === 'string') {
      bed = takeBed(access.tenantId, body.bedId, patient.id);
      if (!bed) return error(409, 'bed_not_available', 'The bed is not available');
    }
    counter += 1;
    const admission: Stored = {
      id: `adm_${counter}`,
      tenantId: access.tenantId,
      patientId: patient.id,
      patientName: patient.name,
      patientMrn: patient.mrn,
      encounterId: `enc_adm_${counter}`,
      doctorId: doctor.id,
      doctorName: doctor.name,
      departmentId: doctor.departmentId,
      departmentName: mockDepartment(access.tenantId, doctor.departmentId)?.name ?? '',
      admissionType: body.admissionType as Admission['admissionType'],
      status: 'admitted',
      admittedAt: new Date().toISOString(),
      ...(typeof body.adviceNote === 'string' ? { adviceNote: body.adviceNote } : {}),
      ...(typeof body.attendantName === 'string' ? { attendantName: body.attendantName } : {}),
      ...(typeof body.attendantRelation === 'string'
        ? { attendantRelation: body.attendantRelation as Admission['attendantRelation'] }
        : {}),
      ...(typeof body.attendantPhone === 'string' ? { attendantPhone: body.attendantPhone } : {}),
      ...(typeof body.depositMinor === 'number' ? { depositMinor: body.depositMinor } : {}),
      consents: Array.isArray(body.consents) ? (body.consents as Admission['consents']) : [],
      ...(bed ? { bed: bedOf(bed) } : {}),
      version: 1,
      key,
    };
    if (bed) recordStay(admission, bed, false);
    admissions.unshift(admission);
    return HttpResponse.json(shown(admission), { status: 201 });
  }),

  http.post('*/api/admissions/:admissionId/:action', async ({ request, params }) => {
    const discharging = params.action === 'discharge';
    const access = authorize(request, {
      permission: discharging ? 'admission:discharge' : 'admission:transfer',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (request.headers.get('idempotency-key') === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const admissionId = String(params.admissionId);
    if (params.action !== 'assign-bed' && params.action !== 'transfer' && !discharging) {
      return error(404, 'not_found', 'Not in this mock');
    }
    const admission = admissions.find(
      (candidate) => candidate.id === admissionId && candidate.tenantId === access.tenantId,
    );
    if (!admission) return error(404, 'admission_not_found', 'No such admission');
    const body = (await request.json().catch(() => null)) as {
      bedId?: unknown;
      reason?: unknown;
      note?: unknown;
      dischargeType?: unknown;
      version?: unknown;
    } | null;
    if (discharging) {
      const types = ['routine', 'against_advice', 'referred', 'absconded', 'deceased'];
      if (
        !body ||
        typeof body.version !== 'number' ||
        typeof body.dischargeType !== 'string' ||
        !types.includes(body.dischargeType)
      ) {
        return error(400, 'validation_failed', 'The request is not valid');
      }
      if (admission.status !== 'admitted') return error(409, 'invalid_transition', 'Discharged');
      if (admission.version !== body.version) return error(409, 'conflict', 'It has changed');
      if (mockNotesOf(admission.encounterId).some((note) => note.status === 'draft')) {
        return error(409, 'unsigned_notes', 'A note of the stay is still a draft');
      }
      const left = admission.bed?.bedId;
      const bed = left
        ? mockBoardBeds(access.tenantId).find((each) => each.id === left)
        : undefined;
      if (bed) {
        setMockBedStatus(bed.id, 'cleaning');
        sittingIn.delete(bed.id);
        announce(access.tenantId, bed.wardId);
        const open = admission.stays?.find((stay) => stay.releasedAt === undefined);
        if (open) {
          open.releasedAt = new Date().toISOString();
          open.releaseReason = 'discharge';
        }
      }
      delete admission.bed;
      Object.assign(admission, {
        status: 'discharged',
        dischargedAt: new Date().toISOString(),
        dischargeType: body.dischargeType,
        version: admission.version + 1,
      });
      return HttpResponse.json({ admission: shown(admission), stays: admission.stays ?? [] });
    }
    if (!body || typeof body.bedId !== 'string' || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (admission.status !== 'admitted') return error(409, 'invalid_transition', 'Discharged');
    if (admission.version !== body.version) return error(409, 'conflict', 'It has changed');
    const reasons = [
      'clinical',
      'step_down',
      'isolation',
      'patient_request',
      'ward_closure',
      'other',
    ];
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const note = typeof body.note === 'string' ? body.note.trim() : undefined;
    if (
      (body.reason !== undefined && (reason === undefined || !reasons.includes(reason))) ||
      (body.note !== undefined && (note === undefined || note === '' || reason === undefined))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const bed = takeBed(access.tenantId, body.bedId, admission.patientId, admission.bed?.bedId);
    if (!bed) return error(409, 'bed_not_available', 'The bed is not available');
    counter += 1;
    recordStay(admission, bed, true, {
      ...(reason ? { moveReason: reason as Stay['moveReason'] } : {}),
      ...(note ? { moveNote: note } : {}),
    });
    Object.assign(admission, { bed: bedOf(bed), version: admission.version + 1 });
    return HttpResponse.json(shown(admission));
  }),
];
