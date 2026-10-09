import { http, HttpResponse } from 'msw';
import type { Health } from '@/shared/api/health';
import { currentPolicy, currentSession, switchTenant } from './db';
import { noticesHandlers } from './handlers/notices';
import { error, tenantMismatch, unauthenticated } from './respond';

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
    if (typeof tenantId !== 'string') {
      return error(400, 'validation_failed', 'tenantId is required');
    }
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

  // Feature handlers: one line per feature.
  ...noticesHandlers,
];
