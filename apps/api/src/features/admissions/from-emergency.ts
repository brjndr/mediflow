import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { openInpatientEncounter } from '../clinical/index.js';
import { ownDoctorId, practisingDoctor } from '../doctors/index.js';
import { activeAdmissionOf, insertAdmission, refusedBy } from './repository.js';

/**
 * What the emergency module asks of admissions (ER-02, #172): admitting a patient from the
 * department, with the stay's own inpatient encounter and no bed (assignBed gives one). The
 * history stays where it was made: the emergency encounter, its orders and notes are not copied.
 *
 * The caller must hold `admission:create` with the admissions module on (403), and the doctor is
 * the one named, else the caller's own profile (422 `unknown_doctor`). A patient already admitted
 * is 409 `already_admitted`.
 */
export async function admitFromEmergency(
  request: FastifyRequest,
  input: { patientId: string; doctorId?: string; adviceNote?: string },
): Promise<{ admissionId: string; encounterId: string }> {
  const policy = await request.access.policy();
  const grant = policy?.permissions.find((held) => held.permission === 'admission:create');
  if (policy?.features['admissions'] !== true || !grant) {
    throw new HttpError(403, 'permission_denied', 'You do not have permission to admit');
  }
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  const client = request.txClient;
  const doctorId = input.doctorId ?? (await ownDoctorId(client, userId));
  const doctor = doctorId
    ? await practisingDoctor(client, doctorId, { scope: grant.scope ?? 'all', userId })
    : null;
  if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');
  if ((await activeAdmissionOf(client, input.patientId)) !== null) {
    throw new HttpError(409, 'already_admitted', 'The patient is already admitted');
  }
  const encounterId = await openInpatientEncounter(
    client,
    { patientId: input.patientId, doctorId: doctor.id, departmentId: doctor.department_id },
    userId,
  );
  let admissionId: string;
  try {
    admissionId = await insertAdmission(
      client,
      {
        patientId: input.patientId,
        encounterId,
        doctorId: doctor.id,
        departmentId: doctor.department_id,
        admissionType: 'emergency',
        ...(input.adviceNote === undefined ? {} : { adviceNote: input.adviceNote }),
      },
      userId,
    );
  } catch (error) {
    if (refusedBy(error, '23505', 'admissions_one_active')) {
      throw new HttpError(409, 'already_admitted', 'The patient is already admitted');
    }
    throw error;
  }
  request.audit('create', 'admission', admissionId);
  await request.emit('encounter.opened', encounterId, {
    encounterId,
    patientId: input.patientId,
    type: 'ipd',
    doctorId: doctor.id,
    departmentId: doctor.department_id,
  });
  await request.emit('admission.created', admissionId, {
    admissionId,
    patientId: input.patientId,
    encounterId,
    doctorId: doctor.id,
    departmentId: doctor.department_id,
    admissionType: 'emergency',
  });
  return { admissionId, encounterId };
}
