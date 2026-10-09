import { setupWorker } from 'msw/browser';
import { isMockUser, signIn, signOut } from './db';
import { handlers } from './handlers';

/**
 * Dev only: pick who the mock backend treats as signed in with `?mockUser=<id>` (a user id from
 * mocks/db.ts, e.g. user_doctor) or `?mockUser=none` to be signed out. Until login exists (A-01)
 * this is the only way to see the app as another user. The real app never reads identity or
 * tenant from the URL.
 */
function applyMockUser() {
  const requested = new URLSearchParams(window.location.search).get('mockUser');
  if (requested === 'none') signOut();
  else if (requested && isMockUser(requested)) signIn(requested);
}

applyMockUser();

export const worker = setupWorker(...handlers);
