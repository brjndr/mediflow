import { http, HttpResponse } from 'msw';
import { error } from '../respond';

/**
 * Email links for invites and password resets. Tokens are fixed words so tests and local
 * exploring can reach every state; each works once, as on the real API.
 */
export const MOCK_INVITE_NEW = 'mock-invite-new';
export const MOCK_INVITE_EXISTING = 'mock-invite-existing';
export const MOCK_RESET = 'mock-reset';

const spent = new Set<string>();

/** Forgets which links were used. For tests. */
export function resetAccountLinks() {
  spent.clear();
}

const invalidLink = () => error(400, 'invalid_token', 'This link is not valid or has expired');

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function weakPassword(password: unknown) {
  if (typeof password !== 'string' || [...password].length < 12) {
    return error(400, 'password_too_short', 'The password needs at least 12 characters');
  }
  if (/password|123456/i.test(password)) {
    return error(400, 'password_too_common', 'The password is too easy to guess');
  }
  return null;
}

export const accountHandlers = [
  http.post('*/api/auth/invite/inspect', async ({ request }) => {
    const { token } = await readBody(request);
    if (typeof token !== 'string' || spent.has(token)) return invalidLink();
    if (token === MOCK_INVITE_NEW) {
      return HttpResponse.json({
        email: 'new.nurse@sample-hospital.test',
        hospitalName: 'Sample Hospital',
        needsPassword: true,
      });
    }
    if (token === MOCK_INVITE_EXISTING) {
      return HttpResponse.json({
        email: 'doctor@sample-hospital.test',
        hospitalName: 'Sample Hospital',
        needsPassword: false,
      });
    }
    return invalidLink();
  }),

  http.post('*/api/auth/invite/accept', async ({ request }) => {
    const { token, password } = await readBody(request);
    if (typeof token !== 'string' || spent.has(token)) return invalidLink();
    if (token !== MOCK_INVITE_NEW && token !== MOCK_INVITE_EXISTING) return invalidLink();
    if (token === MOCK_INVITE_NEW) {
      if (password === undefined) {
        return error(400, 'password_required', 'Choose a password to accept the invite');
      }
      const weak = weakPassword(password);
      if (weak) return weak;
    }
    spent.add(token);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/auth/password/forgot', () => new HttpResponse(null, { status: 204 })),

  http.post('*/api/auth/password/reset', async ({ request }) => {
    const { token, password } = await readBody(request);
    if (token !== MOCK_RESET || spent.has(MOCK_RESET)) return invalidLink();
    const weak = weakPassword(password);
    if (weak) return weak;
    spent.add(MOCK_RESET);
    return new HttpResponse(null, { status: 204 });
  }),
];
