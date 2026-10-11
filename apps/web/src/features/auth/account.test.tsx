import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_INVITE_EXISTING,
  MOCK_INVITE_NEW,
  MOCK_RESET,
  resetAccountLinks,
} from '@/mocks/handlers/auth';
import { signOut as signOutOnServer } from '@/mocks/db';
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

beforeEach(() => resetAccountLinks());

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
