import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { patientInScope } from '../patients/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

export const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

export const isCode = (error: unknown, code: string, constraint?: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === code &&
  (constraint === undefined || (error as { constraint?: unknown }).constraint === constraint);

/** A text a person typed, as it is stored: no spaces at the ends. */
export const tidy = (value: string): string => value.trim();

/**
 * 404 `patient_not_found` unless the caller may read the patient: one they may not read and one
 * that does not exist are the same answer.
 */
export async function requirePatient(request: FastifyRequest, patientId: string): Promise<void> {
  const policy = await request.access.policy();
  const grant = policy?.permissions.find((held) => held.permission === 'patient:read');
  if (
    policy?.features.patients !== true ||
    !grant ||
    !isUuid(patientId) ||
    !(await patientInScope(request.txClient, patientId, {
      scope: grant.scope ?? 'all',
      userId: userIdOf(request),
    }))
  ) {
    throw new HttpError(404, 'patient_not_found', 'No such patient');
  }
}

/** Whether an id is a row of a table of this hospital (row-level security does the filtering). */
export async function exists(client: pg.ClientBase, table: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rows } = await client.query(`select 1 from ${table} where id = $1`, [id]);
  return rows.length > 0;
}
