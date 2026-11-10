import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { patientInScope } from '../patients/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

export const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

/**
 * 404 `unknown_patient` unless the caller may read the patient (needs the patients module on and
 * `patient:read`, within its scope): one they may not read and one that does not exist are the
 * same answer.
 */
export async function requirePatient(request: FastifyRequest, patientId: string): Promise<void> {
  const policy = await request.access.policy();
  const grant = policy?.permissions.find((held) => held.permission === 'patient:read');
  if (
    policy?.features['patients'] !== true ||
    !grant ||
    !isUuid(patientId) ||
    !(await patientInScope(request.txClient, patientId, {
      scope: grant.scope ?? 'all',
      userId: userIdOf(request),
    }))
  ) {
    throw new HttpError(404, 'unknown_patient', 'No such patient');
  }
}

/** 403 unless the caller holds a permission the route itself did not need to declare. */
export async function requireGrant(request: FastifyRequest, permission: string): Promise<void> {
  const policy = await request.access.policy();
  if (!policy?.permissions.some((grant) => grant.permission === permission)) {
    throw new HttpError(403, 'permission_denied', 'You do not have permission to do that');
  }
}
