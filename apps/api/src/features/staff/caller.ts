import type { FastifyRequest } from 'fastify';
import { loadPolicy } from '../../core/access/policy.js';
import { HttpError } from '../../core/http/errors.js';

/**
 * What the caller holds, read again once the role-change lock or the rows a request acts on are
 * held. The policy loaded for the guard may predate a deactivation, a change of role or a role
 * edit made while this request waited; someone who no longer holds `permission` changes nothing.
 */
export async function heldNow(request: FastifyRequest, permission: string) {
  const policy = await loadPolicy(
    request.txClient,
    request.tenant?.id ?? '',
    request.session?.userId ?? '',
  );
  if (!policy?.permissions.some((grant) => grant.permission === permission)) {
    throw new HttpError(403, 'permission_denied', `Missing ${permission}`);
  }
  return policy.permissions;
}
