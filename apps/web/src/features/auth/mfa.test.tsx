import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_PASSWORD, setMockMfa, signOut as signOutOnServer, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import {
  MOCK_MFA_CODE,
  MOCK_RECOVERY_CODES,
  MOCK_SECRET,
  setMockMfaAvailable,
  setMockMfaRequired,
} from '@/mocks/handlers/mfa';
import { renderApp } from '@/test/render';

const ADMIN = 'admin@sample-hospital.test';
const HOME = { name: 'Hospital management system' };

async function paste(label: RegExp, text: string) {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  await userEvent.click(field);
  await userEvent.paste(text);
}

/** The login page, up to the code step, for an admin who has an authenticator. */
async function reachCodeStep() {
  setMockMfa(USER_IDS.admin, true);
  signOutOnServer();
  const app = renderApp({ entry: '/login' });
  await paste(/^Email/, ADMIN);
  await paste(/^Password/, MOCK_PASSWORD);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByLabelText(/^Code/);
  return app;
}

// Every hospital has the authenticator switched off until it asks for it. These tests are about a
// hospital that has it on; the last group is about one that does not.
beforeEach(() => setMockMfaAvailable(true));

const verify = () => userEvent.click(screen.getByRole('button', { name: 'Verify' }));

describe('the code step at sign-in', () => {
  it('asks for the code after the password, then signs in', async () => {
    await reachCodeStep();
    expect(screen.queryByLabelText(/^Password/)).not.toBeInTheDocument();

    await paste(/^Code/, MOCK_MFA_CODE);
    await verify();

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('accepts a recovery code', async () => {
    await reachCodeStep();

    await paste(/^Code/, MOCK_RECOVERY_CODES[0]!);
    await verify();

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('refuses a wrong code, clears it, and lets the person try again', async () => {
    await reachCodeStep();

    await paste(/^Code/, '000000');
    await verify();

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not correct');
    expect(screen.getByLabelText(/^Code/)).toHaveValue('');

    await paste(/^Code/, MOCK_MFA_CODE);
    await verify();
    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('goes back to the first step and drops the password when sign-in is refused for good', async () => {
    await reachCodeStep();
    server.use(
      http.post(
        '*/api/auth/login',
        () =>
          new HttpResponse(
            JSON.stringify({ error: { code: 'rate_limited', message: 'x', requestId: 'r' } }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
          ),
      ),
    );

    await paste(/^Code/, MOCK_MFA_CODE);
    await verify();

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts');
    expect(await screen.findByLabelText(/^Email/)).toHaveValue(ADMIN);
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
  });

  it('needs a code before anything is sent', async () => {
    await reachCodeStep();

    await verify();

    expect(await screen.findByText('This field is required.')).toBeVisible();
  });

  it('goes back to the email and password, without the password', async () => {
    await reachCodeStep();

    await userEvent.click(screen.getByRole('button', { name: 'Use a different account' }));

    expect(await screen.findByLabelText(/^Email/)).toHaveValue(ADMIN);
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
  });

  it('does not ask for a code when the password is wrong', async () => {
    setMockMfa(USER_IDS.admin, true);
    signOutOnServer();
    renderApp({ entry: '/login' });

    await paste(/^Email/, ADMIN);
    await paste(/^Password/, 'not-the-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or password is not correct',
    );
    expect(screen.queryByLabelText(/^Code/)).not.toBeInTheDocument();
  });
});

describe('setting up an authenticator', () => {
  async function startSetUp() {
    cleanup();
    const app = renderApp({ entry: '/security' });
    await paste(/^Password/, MOCK_PASSWORD);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
    await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    return app;
  }

  it('asks for the password first, and keeps nothing when it is wrong', async () => {
    renderApp({ entry: '/security' });

    await paste(/^Password/, 'not-the-password');
    await userEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct');
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
    expect(screen.queryByRole('img', { name: 'QR code for your authenticator app' })).toBeNull();
  });

  it('shows the QR code and the key, then the recovery codes once the code is right', async () => {
    await startSetUp();
    expect(screen.getByText(MOCK_SECRET)).toBeInTheDocument();

    await paste(/^Code from the app/, MOCK_MFA_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    for (const code of MOCK_RECOVERY_CODES) expect(list).toHaveTextContent(code);
    // The codes cannot be dismissed before the person says they saved them.
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'I have saved these codes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('keeps the secret and the codes out of the cache once the screen is gone', async () => {
    const { queryClient, unmount } = await startSetUp();
    await paste(/^Code from the app/, MOCK_MFA_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await screen.findByRole('list', { name: 'Recovery codes' });

    unmount();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('refuses a wrong code and stays on the code step', async () => {
    await startSetUp();

    await paste(/^Code from the app/, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not correct');
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).not.toBeInTheDocument();
  });

  it('says so when it is already on', async () => {
    setMockMfa(USER_IDS.admin, true);
    renderApp({ entry: '/security' });

    expect(await screen.findByText('An authenticator is set up for your account.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Set up authenticator' })).not.toBeInTheDocument();
  });

  it('says so when the server reports it is already on', async () => {
    server.use(
      http.post('*/api/auth/mfa/enroll', () =>
        HttpResponse.json(
          { error: { code: 'mfa_already_enabled', message: 'x', requestId: 'r' } },
          { status: 409 },
        ),
      ),
    );
    renderApp({ entry: '/security' });

    await paste(/^Password/, MOCK_PASSWORD);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already set up');
  });

  it('shows a plain message when the server fails, and keeps no password', async () => {
    server.use(http.post('*/api/auth/mfa/enroll', () => new HttpResponse(null, { status: 500 })));
    renderApp({ entry: '/security' });

    await paste(/^Password/, MOCK_PASSWORD);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side');
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
  });

  it('lets a hospital that requires it through once the person is done', async () => {
    setMockMfaRequired(true);
    const { router } = await startSetUp();

    await paste(/^Code from the app/, MOCK_MFA_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await screen.findByRole('list', { name: 'Recovery codes' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'I have saved these codes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    // Not bounced back to the security screen: the session already shows the authenticator as on.
    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it.each([
    ['copies the codes and says so', () => Promise.resolve(), 'Copied.'],
    [
      'says so when the codes cannot be copied',
      () => Promise.reject(new Error('no')),
      'Could not copy',
    ],
  ])('%s', async (_name, writeText, message) => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await startSetUp();
    await paste(/^Code from the app/, MOCK_MFA_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await screen.findByRole('list', { name: 'Recovery codes' });

    await userEvent.click(screen.getByRole('button', { name: 'Copy codes' }));

    expect(await screen.findByText(new RegExp(message))).toBeVisible();
  });
});

describe('a hospital that requires an authenticator', () => {
  it('keeps someone without one on the security screen', async () => {
    setMockMfaRequired(true);
    const { router } = renderApp({ entry: '/' });

    expect(await screen.findByRole('heading', { name: 'Security' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/security');
  });

  it('sends every other address there too', async () => {
    setMockMfaRequired(true);
    const { router } = renderApp({ entry: '/notices' });

    await screen.findByRole('heading', { name: 'Security' });
    expect(router.state.location.pathname).toBe('/security');
  });

  it('lets someone who has one through', async () => {
    setMockMfaRequired(true);
    setMockMfa(USER_IDS.admin, true);

    renderApp({ entry: '/' });

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('does not stop anyone when the hospital does not require it', async () => {
    renderApp({ entry: '/' });
    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('does not stop anyone when the server does not offer the question yet', async () => {
    server.use(
      http.get('*/api/auth/mfa/requirement', () => new HttpResponse(null, { status: 404 })),
    );

    renderApp({ entry: '/' });

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('lets people through when the server fails, without storing that as an answer', async () => {
    server.use(
      http.get('*/api/auth/mfa/requirement', () => new HttpResponse(null, { status: 500 })),
    );

    const { queryClient } = renderApp({ entry: '/' });

    expect(await screen.findByRole('heading', HOME, { timeout: 4000 })).toBeInTheDocument();
    const query = queryClient
      .getQueryCache()
      .getAll()
      .find((candidate) => candidate.queryKey[2] === 'mfa');
    expect(query?.state.status).toBe('error');
    expect(query?.state.data).toBeUndefined();
  });

  it('asks per hospital: the answer is cached under the hospital', async () => {
    setMockMfaRequired(true);
    const { queryClient } = renderApp({ entry: '/' });
    await screen.findByRole('heading', { name: 'Security' });

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys.some((key) => key[0] === 'tenant' && key[2] === 'mfa')).toBe(true);
  });
});

describe('a hospital with the authenticator switched off', () => {
  beforeEach(() => setMockMfaAvailable(false));

  /** Fails the test if the app asks the server about a requirement. */
  function refuseTheQuestion() {
    let asked = 0;
    server.use(
      http.get('*/api/auth/mfa/requirement', () => {
        asked++;
        return HttpResponse.json({ required: true });
      }),
    );
    return () => asked;
  }

  it('has no set-up screen: its address leads to the account page', async () => {
    const { router } = renderApp({ entry: '/security' });

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');
    expect(screen.queryByRole('button', { name: 'Set up authenticator' })).not.toBeInTheDocument();
  });

  it('says nothing about an authenticator on the account page', async () => {
    renderApp({ entry: '/profile' });

    await screen.findByRole('heading', { name: 'Your account' });
    expect(screen.queryByRole('heading', { name: 'Security' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Set up authenticator' })).not.toBeInTheDocument();
  });

  it('requires nothing and does not ask the server', async () => {
    const asked = refuseTheQuestion();

    renderApp({ entry: '/' });

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(asked()).toBe(0);
  });

  it('still shows someone who already has one that it is on', async () => {
    setMockMfa(USER_IDS.admin, true);
    renderApp({ entry: '/profile' });

    expect(await screen.findByText('An authenticator is set up for your account.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Set up authenticator' })).not.toBeInTheDocument();
  });

  it('is one hospital, not all: the link is there once the switch is on', async () => {
    setMockMfaAvailable(true);
    renderApp({ entry: '/profile' });

    expect(await screen.findByRole('link', { name: 'Set up authenticator' })).toBeInTheDocument();
  });
});
