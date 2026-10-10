import { setupWorker } from 'msw/browser';
import { isMockUser, signIn, signOut } from './db';
import { handlers } from './handlers';

/**
 * Dev only: the mock backend starts signed in as the sample hospital admin, so the app opens
 * straight away. Start as someone else with `?mockUser=<id>` (a user id from mocks/db.ts, e.g.
 * user_doctor), or signed out with `?mockUser=none` to use the login page: any sample email
 * with the password in mocks/db.ts. The real app never reads identity or tenant from the URL.
 */
function applyMockUser() {
  const requested = new URLSearchParams(window.location.search).get('mockUser');
  if (requested === 'none') signOut();
  else if (requested && isMockUser(requested)) signIn(requested);
}

applyMockUser();

export const worker = setupWorker(...handlers);
