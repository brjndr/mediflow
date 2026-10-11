import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_INVITE_EXISTING,
  MOCK_INVITE_NEW,
  MOCK_RESET,
  resetAccountLinks,
} from '@/mocks/handlers/auth';
import { signOut as signOutOnServer } from '@/mocks/db';
import { server } from '@/mocks/node';
import { renderApp } from '@/test/render';

const STRONG = 'violet-harbour-lantern-42';

async function open(entry: string) {
  cleanup();
  signOutOnServer();
  return renderApp({ entry });
}

async function fill(label: RegExp, text: string) {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  await userEvent.type(field, text);
}

// The mock keeps which links were used in module state, so every test starts and ends clean.
beforeEach(() => resetAccountLinks());
afterEach(() => resetAccountLinks());

const answer = (url: string, status: number, code: string) =>
  http.post(url, () =>
    HttpResponse.json({ error: { code, message: 'x', requestId: 'req' } }, { status }),
  );

describe('when the server cannot be reached or refuses', () => {
  it.each([
    ['is down', () => HttpResponse.error(), 'Cannot reach the server'],
    ['fails', () => new HttpResponse(null, { status: 500 }), 'Something went wrong on our side'],
    [
      'is busy',
      () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '1' } }),
      'The system is busy',
    ],
  ])('offers a retry on the invite page when the server %s', async (_name, failure, message) => {
    server.use(http.post('*/api/auth/invite/inspect', failure, { once: true }));
    await open(`/invite?token=${MOCK_INVITE_NEW}`);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/invited to Sample Hospital/)).toBeInTheDocument();
  });

  it('shows the error on the forgot-password page and keeps the form', async () => {
    server.use(
      http.post('*/api/auth/password/forgot', () => new HttpResponse(null, { status: 500 })),
    );
    await open('/forgot-password');

    await fill(/^Email/, 'doctor@sample-hospital.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side');
    expect(screen.getByRole('button', { name: 'Send link' })).toBeEnabled();
  });

  it('rejects a malformed email before sending it', async () => {
    await open('/forgot-password');

    await fill(/^Email/, 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));

    expect(await screen.findByText('This value is not in the expected format.')).toBeVisible();
  });

  it('shows the error on the reset page and keeps the link usable', async () => {
    server.use(http.post('*/api/auth/password/reset', () => HttpResponse.error(), { once: true }));
    await open(`/reset-password?token=${MOCK_RESET}`);

    await fill(/^New password/, STRONG);
    await fill(/^Confirm new password/, STRONG);
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');

    await fill(/^New password/, STRONG);
    await fill(/^Confirm new password/, STRONG);
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Your password has been changed/)).toBeInTheDocument();
  });

  it.each([
    ['password_too_short', 'The password needs at least 12 characters.'],
    ['password_too_common', 'too easy to guess'],
  ])('explains the server code %s on the reset page', async (code, message) => {
    server.use(answer('*/api/auth/password/reset', 400, code));
    await open(`/reset-password?token=${MOCK_RESET}`);

    await fill(/^New password/, STRONG);
    await fill(/^Confirm new password/, STRONG);
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('explains password_required when the invite needs a password the page did not send', async () => {
    server.use(answer('*/api/auth/invite/accept', 400, 'password_required'));
    await open(`/invite?token=${MOCK_INVITE_EXISTING}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toBeVisible();
  });
});

describe('moving between screens', () => {
  it('puts focus on the new heading when the page swaps', async () => {
    await open(`/reset-password?token=${MOCK_RESET}`);
    await fill(/^New password/, STRONG);
    await fill(/^Confirm new password/, STRONG);
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    const heading = await screen.findByRole('heading', { name: 'Password changed' });
    expect(heading).toHaveFocus();
  });
});

describe('accepting an invite', () => {
  it('lets a new person choose a password, then sends them to sign in', async () => {
    const { router } = await open(`/invite?token=${MOCK_INVITE_NEW}`);

    expect(await screen.findByText(/invited to Sample Hospital/)).toBeInTheDocument();
    // The secret does not stay in the address.
    expect(router.state.location.search).toBe('');

    await fill(/^New password/, STRONG);
    await fill(/^Confirm new password/, STRONG);
    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByText(/You can now sign in to Sample Hospital/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('checks the password before sending it', async () => {
    await open(`/invite?token=${MOCK_INVITE_NEW}`);

    await fill(/^New password/, 'short');
    await fill(/^Confirm new password/, 'different');
    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByText('The password needs at least 12 characters.')).toBeVisible();
    expect(screen.getByText('The two passwords do not match.')).toBeVisible();
  });

  it('shows the server’s refusal of an obvious password and clears the fields', async () => {
    await open(`/invite?token=${MOCK_INVITE_NEW}`);

    await fill(/^New password/, 'my-password-1234');
    await fill(/^Confirm new password/, 'my-password-1234');
    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('too easy to guess');
    expect(screen.getByLabelText(/^New password/)).toHaveValue('');
  });

  it('asks nothing but a confirmation of someone who already has an account', async () => {
    await open(`/invite?token=${MOCK_INVITE_EXISTING}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByText(/You can now sign in/)).toBeInTheDocument();
  });

  it('gives one notice for a used link', async () => {
    await open(`/invite?token=${MOCK_INVITE_EXISTING}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await screen.findByText(/You can now sign in/);

    // The same link again, as a fresh visit.
    await open(`/invite?token=${MOCK_INVITE_EXISTING}`);
    expect(
      await screen.findByRole('heading', { name: 'This link is not available' }),
    ).toBeVisible();
  });

  it.each(['/invite', '/invite?token=nonsense'])('gives the same notice for %s', async (entry) => {
    await open(entry);
    expect(
      await screen.findByRole('heading', { name: 'This link is not available' }),
    ).toBeVisible();
  });
});

describe('forgotten password', () => {
  it('is reachable from the sign-in page and gives one answer for any address', async () => {
    await open('/login');
    await userEvent.click(await screen.findByRole('link', { name: 'Forgot your password?' }));

    await fill(/^Email/, 'nobody@nowhere.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));

    expect(await screen.findByText(/If that address has an account/)).toBeInTheDocument();
  });

  it('asks for an email first', async () => {
    await open('/forgot-password');

    await userEvent.click(await screen.findByRole('button', { name: 'Send link' }));

    expect(await screen.findByText('This field is required.')).toBeVisible();
  });
});

describe('resetting a password', () => {
  it('sets the new password once, then the link is spent', async () => {
    const { router } = await open(`/reset-password?token=${MOCK_RESET}`);

    await fill(/^New password/, STRONG);
    await fill(/^Confirm new password/, STRONG);
    expect(router.state.location.search).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText(/Your password has been changed/)).toBeInTheDocument();

    await open(`/reset-password?token=${MOCK_RESET}`);
    await fill(/^New password/, STRONG);
    await fill(/^Confirm new password/, STRONG);
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByRole('heading', { name: 'This link is not available' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('shows the notice at once when there is no token', async () => {
    await open('/reset-password');
    expect(
      await screen.findByRole('heading', { name: 'This link is not available' }),
    ).toBeVisible();
  });
});
