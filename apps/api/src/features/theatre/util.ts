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
 * 422 `unknown_patient` unless the caller may read the patient (the patients module on and
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
    throw new HttpError(422, 'unknown_patient', 'No such patient');
  }
}

/** 403 `feature_disabled` unless the module is on for the hospital. */
export async function requireModule(request: FastifyRequest, module: string): Promise<void> {
  if ((await request.access.policy())?.features[module] !== true) {
    throw new HttpError(403, 'feature_disabled', `The ${module} module is off`);
  }
}

/** The instant in a request, or 422 `invalid_time`. */
export function instant(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(422, 'invalid_time', 'Not a valid time');
  }
  return date;
}
