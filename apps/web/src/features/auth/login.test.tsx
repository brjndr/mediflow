import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/session';
import {
  currentSession,
  MOCK_LOGIN_MAX_FAILURES,
  MOCK_LOGIN_RATE_LIMIT,
  MOCK_PASSWORD,
  signOut as signOutOnServer,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { ApiError } from '@/shared/api';
import { renderApp } from '@/test/render';
import { signInErrorKey } from './hooks/use-sign-in';

const LOGIN_URL = '*/api/auth/login';
const HOME = { name: 'Hospital management system' };
const ADMIN = 'admin@sample-hospital.test';
const DOCTOR = 'doctor@sample-hospital.test';
const RECEPTION = 'reception@riverside-clinic.test';
const INVALID =
  'The email or password is not correct, or the account is temporarily locked. Check them and try again.';

/** The app as someone who is not signed in finds it. */
async function openSignedOut(entry = '/') {
  signOutOnServer();
  const app = renderApp({ entry });
  await screen.findByRole('heading', { name: 'Sign in' });
  return app;
}

const emailField = () => screen.getByLabelText(/^Email/);
const passwordField = () => screen.getByLabelText(/^Password/);

/** Fills a field in one step, as a password manager does. Typing key by key is slow in jsdom. */
async function fill(field: HTMLElement, text: string) {
  await userEvent.clear(field);
  if (!text) return;
  await userEvent.click(field);
  await userEvent.paste(text);
}

async function submit(email: string, password: string) {
  await fill(emailField(), email);
  await fill(passwordField(), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

/** Counts sign-in requests that reach the server. */
function watchLogins() {
  const seen: unknown[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.url.endsWith('/api/auth/login')) seen.push(request.url);
  });
  return seen;
}

describe('the login page', () => {
  it('is generic: it names no hospital and offers only email and password', async () => {
    await openSignedOut();

    expect(screen.getByText('Mediflow')).toBeInTheDocument();
    expect(screen.queryByText(/Sample Hospital|Riverside Clinic/)).not.toBeInTheDocument();
    expect(emailField()).toHaveAttribute('autocomplete', 'username');
    expect(passwordField()).toHaveAttribute('type', 'password');
    expect(passwordField()).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });

  it('signs in and opens the app for someone with one hospital', async () => {
    const { router } = await openSignedOut();

    await submit(ADMIN, MOCK_PASSWORD);

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByText('Sample Admin')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('accepts the email in any case and with spaces around it', async () => {
    await openSignedOut();

    await submit(`  ${ADMIN.toUpperCase()}  `, MOCK_PASSWORD);

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('returns the user to the address they asked for', async () => {
    const { router } = await openSignedOut('/notices?page=2');
    expect(router.state.location.pathname).toBe('/login');

    await submit(ADMIN, MOCK_PASSWORD);

    expect(await screen.findByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
    expect(router.state.location).toMatchObject({ pathname: '/notices', search: '?page=2' });
  });

  it('shows the hospital picker to someone who works at several', async () => {
    await openSignedOut();

    await submit(DOCTOR, MOCK_PASSWORD);

    expect(await screen.findByRole('heading', { name: 'Choose a hospital' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Riverside Clinic' }));
    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('asks for both fields before sending anything', async () => {
    const logins = watchLogins();
    await openSignedOut();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findAllByText('This field is required.')).toHaveLength(2);
    expect(emailField()).toBeInvalid();
    expect(passwordField()).toBeInvalid();
    expect(logins).toHaveLength(0);
  });

  it('keeps the button disabled while signing in, so a double click sends once', async () => {
    const logins = watchLogins();
    await openSignedOut();
    server.use(
      http.post(LOGIN_URL, async () => {
        await delay(50);
        return undefined;
      }),
    );

    await submit(ADMIN, MOCK_PASSWORD);

    const button = await screen.findByRole('button', { name: 'Signing in…' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(logins).toHaveLength(1);
  });
});

describe('a refused sign-in', () => {
  it('says the same thing for an unknown email, a wrong password and a locked account', async () => {
    await openSignedOut();
    const message = async () => (await screen.findByRole('alert')).textContent;

    await submit('nobody@sample-hospital.test', MOCK_PASSWORD);
    const unknown = await message();

    await submit(ADMIN, 'not the right password');
    const wrong = await message();

    for (let attempt = 2; attempt <= MOCK_LOGIN_MAX_FAILURES; attempt++) {
      await submit(ADMIN, 'not the right password');
      await waitFor(() => expect(passwordField()).toHaveValue(''));
    }
    // Locked now: even the right password is refused, in the same words.
    await submit(ADMIN, MOCK_PASSWORD);
    await waitFor(() => expect(passwordField()).toHaveValue(''));
    const locked = await message();

    expect(unknown).toBe(INVALID);
    expect(wrong).toBe(INVALID);
    expect(locked).toBe(INVALID);
    expect(currentSession()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps the email, clears the password and puts the cursor back in it', async () => {
    await openSignedOut();

    await submit(ADMIN, 'not the right password');

    await screen.findByRole('alert');
    expect(emailField()).toHaveValue(ADMIN);
    expect(passwordField()).toHaveValue('');
    expect(passwordField()).toHaveFocus();
  });

  it('never shows what the server said', async () => {
    await openSignedOut();
    server.use(
      http.post(LOGIN_URL, () =>
        HttpResponse.json(
          { error: { code: 'invalid_credentials', message: 'no user admin@x in table users' } },
          { status: 401 },
        ),
      ),
    );

    await submit(ADMIN, MOCK_PASSWORD);

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID);
    expect(screen.queryByText(/table users/)).not.toBeInTheDocument();
  });

  it('says so at once when there have been too many attempts, without retrying', async () => {
    await openSignedOut();
    for (let attempt = 1; attempt <= MOCK_LOGIN_RATE_LIMIT; attempt++) {
      await submit('nobody@sample-hospital.test', 'not the right password');
      await waitFor(() => expect(passwordField()).toHaveValue(''));
    }
    const logins = watchLogins();

    await submit(ADMIN, MOCK_PASSWORD);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Too many sign-in attempts. Wait a minute and try again.',
      ),
    );
    // The server asked for a minute's wait. The form does not sit through it.
    expect(logins).toHaveLength(1);
    expect(currentSession()).toBeNull();
  });

  it('explains when the account needs an authenticator code', async () => {
    await openSignedOut();
    server.use(
      http.post(LOGIN_URL, () =>
        HttpResponse.json({ error: { code: 'mfa_required', message: 'x' } }, { status: 401 }),
      ),
    );

    await submit(ADMIN, MOCK_PASSWORD);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account needs a code from an authenticator app',
    );
  });

  it('tells a connection problem apart from wrong details', async () => {
    await openSignedOut();
    server.use(http.post(LOGIN_URL, () => HttpResponse.error()));

    await submit(ADMIN, MOCK_PASSWORD);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot reach the server. Check your connection and try again.',
    );
    // Nothing was wrong with what they typed, but a password is still not left in the page.
    expect(emailField()).toHaveValue(ADMIN);
  });

  it('maps every kind of failure to a message of its own, never to raw text', () => {
    const failure = (code: ApiError['code'], serverCode?: string) =>
      signInErrorKey(new ApiError({ code, serverCode }));

    expect(failure('unauthorized', 'invalid_credentials')).toBe('login.invalid');
    expect(failure('unauthorized')).toBe('login.invalid');
    expect(failure('unauthorized', 'invalid_mfa_code')).toBe('login.mfaUnavailable');
    expect(failure('rate_limited')).toBe('login.rateLimited');
    expect(failure('timeout')).toBe('errors.timeout');
    expect(failure('server')).toBe('errors.server');
    expect(failure('forbidden', 'cross_site_request')).toBe('errors.unknown');
    expect(signInErrorKey(new Error('admin@sample-hospital.test not found'))).toBe(
      'errors.unknown',
    );
  });
});

describe('signing out', () => {
  async function openSignedIn(entry = '/notices') {
    const app = renderApp({ entry });
    await screen.findByRole('heading', { name: 'Staff notices' });
    return app;
  }

  it('ends the session on the server and drops everything loaded under it', async () => {
    const { queryClient, router } = await openSignedIn();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['tenant'] }).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(currentSession()).toBeNull();
    expect(queryClient.getQueryData(sessionKey)).toBeNull();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['tenant'] })).toEqual([]);
    expect(router.state.location.pathname).toBe('/login');
  });

  it('does not take the next person to the screen the last one was on', async () => {
    const { router } = await openSignedIn('/notices');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });

    await submit(RECEPTION, MOCK_PASSWORD);

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(within(screen.getByRole('banner')).getByText('Sample Receptionist')).toBeInTheDocument();
    expect(screen.queryByText('Sample Admin')).not.toBeInTheDocument();
  });

  it('leaves the user signed in, and says so, when the server cannot be reached', async () => {
    await openSignedIn();
    server.use(http.post('*/api/auth/logout', () => HttpResponse.error()));

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are still signed in. Cannot reach the server. Check your connection and try again.',
    );
    expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
    expect(currentSession()).not.toBeNull();
  });
});
