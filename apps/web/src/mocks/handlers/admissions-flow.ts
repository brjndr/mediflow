import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockDepartment } from './departments';
import { mockDoctor, mockDoctorOfUser } from './doctors';
import { mockPatient } from './patients';
import { mockBoardBeds, setMockBedStatus } from './wards';

type Admission = components['schemas']['Admission'];
type AdmissionPage = components['schemas']['AdmissionPage'];
type Stored = Admission & { key?: string };

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
  const { key: _key, ...admission } = stored;
  return admission;
}

export const admissionFlowHandlers = [
  http.get('*/api/admissions', ({ request }) => {
    const access = authorize(request, { permission: 'admission:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const status = query.get('status');
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const all = admissions.filter(
      (admission) =>
        admission.tenantId === access.tenantId && (!status || admission.status === status),
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
      ...(bed ? { bed: bedOf(bed) } : {}),
      version: 1,
      key,
    };
    admissions.unshift(admission);
    return HttpResponse.json(shown(admission), { status: 201 });
  }),

  http.post('*/api/admissions/:admissionId/:action', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'admission:transfer',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (request.headers.get('idempotency-key') === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const admissionId = String(params.admissionId);
    if (params.action !== 'assign-bed' && params.action !== 'transfer') {
      return error(404, 'not_found', 'Not in this mock');
    }
    const admission = admissions.find(
      (candidate) => candidate.id === admissionId && candidate.tenantId === access.tenantId,
    );
    if (!admission) return error(404, 'admission_not_found', 'No such admission');
    const body = (await request.json().catch(() => null)) as {
      bedId?: unknown;
      version?: unknown;
    } | null;
    if (!body || typeof body.bedId !== 'string' || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (admission.status !== 'admitted') return error(409, 'invalid_transition', 'Discharged');
    if (admission.version !== body.version) return error(409, 'conflict', 'It has changed');
    const bed = takeBed(access.tenantId, body.bedId, admission.patientId, admission.bed?.bedId);
    if (!bed) return error(409, 'bed_not_available', 'The bed is not available');
    counter += 1;
    Object.assign(admission, { bed: bedOf(bed), version: admission.version + 1 });
    return HttpResponse.json(shown(admission));
  }),
];
