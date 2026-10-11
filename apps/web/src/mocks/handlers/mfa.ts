import { http, HttpResponse } from 'msw';
import {
  currentSession,
  MOCK_PASSWORD,
  mockMfaEnabledFor,
  onMockReset,
  setMockMfa,
  setTenantFeature,
  TENANT_IDS,
} from '../db';
import { error, unauthenticated } from '../respond';

/** The only code the mock accepts, from an authenticator or as a recovery code. */
export const MOCK_MFA_CODE = '123456';
export const MOCK_SECRET = 'JBSWY3DPEHPK3PXP';
export const MOCK_RECOVERY_CODES = ['mock-aaaa-1111', 'mock-bbbb-2222', 'mock-cccc-3333'];

let enrolling = false;

/** Offers the authenticator at a hospital, as its `mfa` switch does. Off for every mock hospital. */
export function setMockMfaAvailable(value: boolean, tenantId: string = TENANT_IDS.hospital): void {
  setTenantFeature(tenantId, 'mfa', value);
}

/** Makes a hospital require an authenticator: both of its switches, as on the server. */
export function setMockMfaRequired(value: boolean, tenantId: string = TENANT_IDS.hospital): void {
  if (value) setTenantFeature(tenantId, 'mfa', true);
  setTenantFeature(tenantId, 'mfa_required', value);
}

onMockReset(() => {
  enrolling = false;
});

const invalidCode = () => error(401, 'invalid_mfa_code', 'That code is not valid');

/**
 * Sign-in for an account with an authenticator. Placed ahead of the plain sign-in handler: once
 * the password is right it asks for a code, then lets the plain handler finish. A wrong password
 * is left to that handler, so it gets the one answer every wrong password gets.
 */
export const mfaLoginHandlers = [
  http.post('*/api/auth/login', async ({ request }) => {
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);
    const { email, password, code } =
      typeof body === 'object' && body !== null
        ? (body as { email?: unknown; password?: unknown; code?: unknown })
        : {};
    if (typeof email !== 'string' || password !== MOCK_PASSWORD) return undefined;
    if (!mockMfaEnabledFor(email)) return undefined;
    if (code === undefined) return error(401, 'mfa_required', 'A code is required');
    if (code !== MOCK_MFA_CODE && !MOCK_RECOVERY_CODES.includes(String(code))) return invalidCode();
    return undefined;
  }),
];

export const mfaHandlers = [
  http.get('*/api/auth/mfa/requirement', () => {
    const session = currentSession();
    if (!session) return unauthenticated();
    if (!session.activeTenant) return error(409, 'no_active_tenant', 'Pick a hospital first');
    const features = session.activeTenant.features;
    return HttpResponse.json({ required: features.mfa === true && features.mfa_required === true });
  }),

  http.post('*/api/auth/mfa/enroll', async ({ request }) => {
    const session = currentSession();
    if (!session) return unauthenticated();
    const body: unknown = await request.json().catch(() => null);
    const password =
      typeof body === 'object' && body !== null ? (body as { password?: unknown }).password : null;
    if (password !== MOCK_PASSWORD) {
      return error(403, 'invalid_password', 'The password is not correct');
    }
    if (session.user.mfaEnabled) {
      return error(409, 'mfa_already_enabled', 'An authenticator is already set up');
    }
    enrolling = true;
    return HttpResponse.json({
      secret: MOCK_SECRET,
      otpauthUri: `otpauth://totp/Mediflow:${session.user.email}?secret=${MOCK_SECRET}&issuer=Mediflow`,
    });
  }),

  http.post('*/api/auth/mfa/confirm', async ({ request }) => {
    const session = currentSession();
    if (!session) return unauthenticated();
    const body: unknown = await request.json().catch(() => null);
    const code =
      typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    if (!enrolling || code !== MOCK_MFA_CODE) {
      return error(400, 'invalid_mfa_code', 'That code is not valid');
    }
    enrolling = false;
    setMockMfa(session.user.id, true);
    return HttpResponse.json({ recoveryCodes: MOCK_RECOVERY_CODES });
  }),
];
