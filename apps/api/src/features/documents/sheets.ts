import type { FastifyRequest } from 'fastify';
import { encounterVisibleSql } from '../clinical/index.js';

/**
 * Who may read a scanned OPD sheet (#1200). The paper holds the diagnosis, so `document:read`
 * alone is not enough: the caller also needs `diagnosis:read`, within its scope of the sheet's
 * visit. Every query that shows a document to a person adds this condition; a sheet the caller
 * may not read is treated as one that is not there.
 */
export async function sheetReader(request: FastifyRequest) {
  const policy = await request.access.policy();
  const grant = policy?.permissions.find((held) => held.permission === 'diagnosis:read');
  return {
    /** `none` matches no visit. */
    scope: grant ? (grant.scope ?? 'all') : 'none',
    userId: request.session?.userId ?? '',
  };
}

/**
 * The condition for a row of `patient_documents`, named `table` in the query (never `d` or `e`,
 * which the visit's own subquery uses); `scope` and `user` are placeholders.
 */
export const sheetVisibleSql = (table: string, scope: string, user: string) =>
  `(${table}.category <> 'opd_sheet'
    or ${encounterVisibleSql(`${table}.encounter_id`, scope, user)})`;
