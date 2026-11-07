import type { FastifyRequest } from 'fastify';
import type { PermissionScope } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { patientInScope } from '../patients/index.js';
import { isUuid } from './page.js';

export const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

export const iso = (value: Date): string => value.toISOString();

/** The scope the caller holds a permission of another module with, or null when off or not held. */
async function grantOf(
  request: FastifyRequest,
  permission: string,
  feature: string,
): Promise<PermissionScope | null> {
  const policy = await request.access.policy();
  if (policy?.features[feature] !== true) return null;
  const grant = policy.permissions.find((held) => held.permission === permission);
  return grant ? (grant.scope ?? 'all') : null;
}

/**
 * 422 `unknown_patient` unless the caller may read the patient: one they may not read and one that
 * does not exist are the same answer.
 */
export async function requirePatient(request: FastifyRequest, patientId: string): Promise<void> {
  const scope = await grantOf(request, 'patient:read', 'patients');
  if (
    scope === null ||
    !isUuid(patientId) ||
    !(await patientInScope(request.txClient, patientId, { scope, userId: userIdOf(request) }))
  ) {
    throw new HttpError(422, 'unknown_patient', 'No such patient');
  }
}

/** Whether a module flag is on for the caller's hospital. */
export async function featureOn(request: FastifyRequest, feature: string): Promise<boolean> {
  return (await request.access.policy())?.features[feature] === true;
}

/** Ids from the path that are not UUIDs are the same 404 as ones that do not exist. */
export const uuidOr404 = (value: string, code: string, message: string): string => {
  if (!isUuid(value)) throw new HttpError(404, code, message);
  return value;
};

export const isCode = (error: unknown, code: string, constraint?: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === code &&
  (constraint === undefined || (error as { constraint?: unknown }).constraint === constraint);

/** 403 unless the caller holds a permission the route itself did not need to declare. */
export async function requireGrant(request: FastifyRequest, permission: string): Promise<void> {
  const policy = await request.access.policy();
  if (!policy?.permissions.some((grant) => grant.permission === permission)) {
    throw new HttpError(403, 'permission_denied', 'You do not have permission to do that');
  }
}
