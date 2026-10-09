import { http, HttpResponse } from 'msw';
import type { Health } from '@/shared/api/health';
import { activeTenantId, currentPolicy, currentSession, switchTenant } from './db';

const TENANT_HEADER = 'X-Tenant-ID';

function error(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message, requestId: 'req_mock' } }, { status });
}

const unauthenticated = () => error(401, 'unauthenticated', 'No session');

/**
 * What the real API does on every tenant-scoped route: a tenant header that disagrees with the
 * session (a stale tab after a hospital switch) is rejected, never honoured.
 */
function tenantMismatch(request: Request) {
  const sent = request.headers.get(TENANT_HEADER);
  return sent && sent !== activeTenantId()
    ? error(409, 'tenant_mismatch', 'X-Tenant-ID does not match the session tenant')
    : null;
}

export const handlers = [
  http.get('*/api/health', () => HttpResponse.json<Health>({ status: 'ok' })),

  http.get('*/api/session', () => {
    const session = currentSession();
    return session ? HttpResponse.json(session) : unauthenticated();
  }),

  http.post('*/api/session/switch-tenant', async ({ request }) => {
    if (!currentSession()) return unauthenticated();
    const body: unknown = await request.json().catch(() => null);
    const tenantId =
      typeof body === 'object' && body !== null && 'tenantId' in body ? body.tenantId : undefined;
    if (typeof tenantId !== 'string')
      return error(400, 'validation_failed', 'tenantId is required');
    if (!switchTenant(tenantId)) return error(403, 'not_a_member', 'No membership in that tenant');
    return HttpResponse.json(currentSession());
  }),

  http.get('*/api/session/policy', ({ request }) => {
    if (!currentSession()) return unauthenticated();
    const mismatch = tenantMismatch(request);
    if (mismatch) return mismatch;
    const policy = currentPolicy();
    if (!policy) return error(409, 'no_active_tenant', 'Pick a hospital first');
    const etag = `"${policy.version}"`;
    if (request.headers.get('If-None-Match') === etag) {
      return new HttpResponse(null, { status: 304, headers: { ETag: etag } });
    }
    return HttpResponse.json(policy, { headers: { ETag: etag } });
  }),
];
