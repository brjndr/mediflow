import { http, HttpResponse, passthrough } from 'msw';
import type { Health } from '@/shared/api/health';
import {
  attemptSignIn,
  currentPolicy,
  currentSession,
  openLink,
  signOut,
  switchTenant,
} from './db';
import { mfaLoginHandlers } from './handlers/mfa';
import { error, tenantMismatch, unauthenticated } from './respond';

/**
 * Everything that is not the API (scripts, styles, fonts, images) goes straight to the network.
 * MSW offers each request to the handlers in turn, and for every one it reads the cookies and
 * parses the URL even when the path does not match, so the several hundred handlers cost
 * seconds of main-thread time on a phone for the chunks of a page alone (#1174). One handler
 * ahead of them all answers those requests at once.
 */
export const notTheApi = http.all(/^(?!.*\/api\/)/, () => passthrough());

/**
 * The handlers every page needs: health, sign-in and the session. The browser builds these at
 * start-up and the feature handlers when a request first asks for them (`lazy-api.ts`, #1176).
 */
export const coreHandlers = [
  // Ahead of the plain sign-in: asks for a code when the account has an authenticator.
  ...mfaLoginHandlers,
  http.get('*/api/health', () => HttpResponse.json<Health>({ status: 'ok' })),

  http.post('*/api/auth/login', async ({ request }) => {
    const body: unknown = await request.json().catch(() => null);
    const { email, password } =
      typeof body === 'object' && body !== null
        ? (body as { email?: unknown; password?: unknown })
        : {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return error(400, 'validation_failed', 'email and password are required');
    }
    const outcome = attemptSignIn(email, password);
    if (outcome === 'rate_limited') {
      return HttpResponse.json(
        { error: { code: 'rate_limited', message: 'Too many attempts', requestId: 'req_mock' } },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }
    if (outcome === 'invalid') {
      // One answer whatever was wrong, as the real API gives.
      return error(
        401,
        'invalid_credentials',
        'Email or password is incorrect, or the account is temporarily locked',
      );
    }
    return HttpResponse.json(currentSession());
  }),

  http.post('*/api/auth/logout', () => {
    signOut();
    return new HttpResponse(null, { status: 204 });
  }),

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

  http.post('*/api/session/open-link', async ({ request }) => {
    if (!currentSession()) return unauthenticated();
    const body: unknown = await request.json().catch(() => null);
    const { kind, id } =
      typeof body === 'object' && body !== null ? (body as { kind?: unknown; id?: unknown }) : {};
    if (typeof kind !== 'string' || typeof id !== 'string') {
      return error(400, 'validation_failed', 'kind and id are required');
    }
    // One answer for a record that does not exist and one the user may not see.
    if (!openLink(kind, id)) return error(403, 'link_unavailable', 'This link is not available');
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
