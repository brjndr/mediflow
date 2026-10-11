import { http, HttpResponse } from 'msw';
import { currentSession, MOCK_PASSWORD, onMockReset } from '../db';
import { error, unauthenticated } from '../respond';

interface MockAccountSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}

/** The session the mock user is in, plus two elsewhere. Synthetic, the same for every user. */
const initialSessions = (): MockAccountSession[] => [
  {
    id: 'sess_current',
    createdAt: '2026-10-11T03:30:00Z',
    lastSeenAt: '2026-10-11T06:10:00Z',
    userAgent: 'Chrome on Windows',
    current: true,
  },
  {
    id: 'sess_ward_pc',
    createdAt: '2026-10-09T02:00:00Z',
    lastSeenAt: '2026-10-10T11:45:00Z',
    userAgent: 'Edge on Windows',
    current: false,
  },
  {
    id: 'sess_unknown',
    createdAt: '2026-10-05T14:20:00Z',
    lastSeenAt: '2026-10-05T14:25:00Z',
    userAgent: null,
    current: false,
  },
];

let sessions = initialSessions();

onMockReset(() => {
  sessions = initialSessions();
});

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * The signed-in user's own account: changing the password and ending other sessions. The mock
 * password itself never changes, so the sample sign-ins keep working.
 */
export const profileHandlers = [
  http.post('*/api/auth/password/change', async ({ request }) => {
    if (!currentSession()) return unauthenticated();
    const { currentPassword, newPassword } = await readBody(request);
    if (currentPassword !== MOCK_PASSWORD) {
      return error(403, 'invalid_password', 'The password is not correct');
    }
    if (typeof newPassword !== 'string' || [...newPassword].length < 12) {
      return error(400, 'password_too_short', 'The password needs at least 12 characters');
    }
    if (/password|123456/i.test(newPassword)) {
      return error(400, 'password_too_common', 'The password is too easy to guess');
    }
    // As the real API does: every other session of the user is ended.
    sessions = sessions.filter((s) => s.current);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/auth/sessions', () =>
    currentSession() ? HttpResponse.json({ items: sessions, nextCursor: null }) : unauthenticated(),
  ),

  http.delete('*/api/auth/sessions/:sessionId', ({ params }) => {
    if (!currentSession()) return unauthenticated();
    const target = sessions.find((s) => s.id === params.sessionId);
    if (!target) return error(404, 'not_found', 'No such session');
    if (target.current) return error(409, 'current_session', 'Sign out to end this session');
    sessions = sessions.filter((s) => s !== target);
    return new HttpResponse(null, { status: 204 });
  }),
];
