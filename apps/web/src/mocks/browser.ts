import { setupWorker } from 'msw/browser';
import { isMockUser, setMockLanguage, setMockMfa, signIn, signOut } from './db';
import { handlers } from './handlers';

/**
 * Dev only: the mock backend starts signed in as the sample hospital admin, so the app opens
 * straight away. Start as someone else with `?mockUser=<id>` (a user id from mocks/db.ts, e.g.
 * user_doctor), or signed out with `?mockUser=none` to use the login page: any sample email
 * with the password in mocks/db.ts. `&mockMfa=on` gives that user a confirmed authenticator (a
 * platform admin cannot open the platform area without one). The real app never reads identity or tenant from the URL.
 */
function applyMockUser() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('mockUser');
  if (requested === 'none') signOut();
  else if (requested && isMockUser(requested)) {
    if (params.get('mockMfa') === 'on') setMockMfa(requested, true);
    // `&mockLanguage=hi` gives that user Hindi as their own language (the Hindi checks).
    if (params.get('mockLanguage') === 'hi') setMockLanguage(requested, 'hi');
    signIn(requested);
  }
}

applyMockUser();

export const worker = setupWorker(...handlers);
