import { HttpResponse } from 'msw';
import { activeTenantId, currentPolicy, currentSession } from './db';

const TENANT_HEADER = 'X-Tenant-ID';

export function error(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message, requestId: 'req_mock' } }, { status });
}

export const unauthenticated = () => error(401, 'unauthenticated', 'No session');

/**
 * What the real API does on every tenant-scoped route: a tenant header that disagrees with the
 * session (a stale tab after a hospital switch) is rejected, never honoured.
 */
export function tenantMismatch(request: Request) {
  const sent = request.headers.get(TENANT_HEADER);
  return sent && sent !== activeTenantId()
    ? error(409, 'tenant_mismatch', 'X-Tenant-ID does not match the session tenant')
    : null;
}

interface RouteAccess {
  permission: string;
  featureFlag: string;
}

/**
 * The mock's version of the backend `session`, `tenant` and `access` hooks for a feature route.
 * Returns the active tenant id, or the error response to send. The tenant always comes from the
 * session, never from the request.
 */
export function authorize(
  request: Request,
  { permission, featureFlag }: RouteAccess,
): { tenantId: string } | { denied: Response } {
  if (!currentSession()) return { denied: unauthenticated() };
  const mismatch = tenantMismatch(request);
  if (mismatch) return { denied: mismatch };
  const policy = currentPolicy();
  if (!policy) return { denied: error(409, 'no_active_tenant', 'Pick a hospital first') };
  if (policy.features[featureFlag] !== true) {
    return { denied: error(403, 'feature_disabled', `Feature ${featureFlag} is off`) };
  }
  if (!policy.permissions.some((grant) => grant.permission === permission)) {
    return { denied: error(403, 'permission_denied', `Missing ${permission}`) };
  }
  return { tenantId: policy.tenantId };
}
