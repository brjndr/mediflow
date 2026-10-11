import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK_PASSWORD, setMockMfa, signOut as signOutOnServer, USER_IDS } from '@/mocks/db';
import { setMockMfaAvailable, setMockMfaRequired } from '@/mocks/handlers/mfa';
import { server } from '@/mocks/node';
import { renderApp } from '@/test/render';

const ADMIN = 'admin@sample-hospital.test';
const NEW_PASSWORD = 'a-long-new-phrase-42';

async function paste(label: RegExp, text: string) {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  await userEvent.click(field);
  await userEvent.paste(text);
}

const openProfile = async () => {
  const app = renderApp({ entry: '/profile' });
  await screen.findByRole('heading', { name: 'Your account' });
  return app;
};

const sessionRows = async () =>
  within(await screen.findByRole('list', { name: 'Where you are signed in' })).getAllByRole(
    'listitem',
  );

const submitPassword = () =>
  userEvent.click(screen.getByRole('button', { name: 'Change password' }));

async function fillPasswords(current: string, next: string, confirm = next) {
  await paste(/^Current password/, current);
  await paste(/^New password/, next);
  await paste(/^Confirm new password/, confirm);
}

describe('the account page', () => {
  it('shows who is signed in and offers to set up an authenticator', async () => {
    setMockMfaAvailable(true);
    await openProfile();

    expect(screen.getByText(ADMIN, { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('No authenticator is set up for your account.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up authenticator' })).toHaveAttribute(
      'href',
      '/security',
    );
  });

  it('says so when an authenticator is already set up', async () => {
    setMockMfa(USER_IDS.admin, true);
    await openProfile();

    expect(screen.getByText('An authenticator is set up for your account.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Set up authenticator' })).not.toBeInTheDocument();
  });

  it('is reached from the name in the header', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: /^Your account:/ }));

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
  });

  it('is closed, like every other screen, to someone who must set up an authenticator first', async () => {
    setMockMfaRequired(true);
    renderApp({ entry: '/profile' });

    expect(await screen.findByRole('heading', { name: 'Security' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your account' })).not.toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign in', async () => {
    signOutOnServer();
    renderApp({ entry: '/profile' });

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your account' })).not.toBeInTheDocument();
  });
});

describe('sessions', () => {
  it('lists them, and the one in use cannot be ended here', async () => {
    await openProfile();
    const rows = await sessionRows();

    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('This browser')).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
    expect(within(rows[2]!).getByText('Unknown browser')).toBeInTheDocument();
  });

  it('ends another session, which leaves the list', async () => {
    await openProfile();
    const rows = await sessionRows();

    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'End session' }));

    await waitFor(async () => expect(await sessionRows()).toHaveLength(2));
    expect(screen.queryByText('Edge on Windows')).not.toBeInTheDocument();
  });

  it('says so when a session cannot be ended, and keeps it listed', async () => {
    server.use(
      http.delete('*/api/auth/sessions/:sessionId', () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'boom', requestId: 'req_mock' } },
          { status: 500 },
        ),
      ),
    );
    await openProfile();
    const rows = await sessionRows();

    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'End session' }));

    expect(await within(rows[1]!).findByRole('alert')).toBeInTheDocument();
    expect(await sessionRows()).toHaveLength(3);
  });

  it('offers to try again when the list cannot be loaded', async () => {
    let failed = false;
    server.use(
      http.get('*/api/auth/sessions', () => {
        if (failed) return undefined;
        failed = true;
        return HttpResponse.json(
          { error: { code: 'internal_error', message: 'boom', requestId: 'req_mock' } },
          { status: 500 },
        );
      }),
    );
    await openProfile();

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await sessionRows()).toHaveLength(3);
  });
});

describe('changing the password', () => {
  it('changes it, clears the form and signs the other sessions out', async () => {
    await openProfile();
    expect(await sessionRows()).toHaveLength(3);

    await fillPasswords(MOCK_PASSWORD, NEW_PASSWORD);
    await submitPassword();

    expect(await screen.findByText(/^Your password has been changed\./)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Current password/)).toHaveValue('');
    expect(screen.getByLabelText(/^New password/)).toHaveValue('');
    await waitFor(async () => expect(await sessionRows()).toHaveLength(1));
  });

  it('refuses a wrong current password and keeps neither password', async () => {
    await openProfile();

    await fillPasswords('not-the-password', NEW_PASSWORD);
    await submitPassword();

    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct.');
    expect(screen.getByLabelText(/^Current password/)).toHaveValue('');
    expect(screen.getByLabelText(/^New password/)).toHaveValue('');
    expect(await sessionRows()).toHaveLength(3);
  });

  it('shows the server rule for a password that is too easy to guess', async () => {
    await openProfile();

    await fillPasswords(MOCK_PASSWORD, 'password-password');
    await submitPassword();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That password is too easy to guess.',
    );
  });

  it('checks the length and that both entries match before sending anything', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/auth/password/change', () => {
        calls++;
        return undefined;
      }),
    );
    await openProfile();

    await fillPasswords(MOCK_PASSWORD, 'short');
    await submitPassword();
    expect(
      await screen.findByText('The password needs at least 12 characters.'),
    ).toBeInTheDocument();

    await fillPasswords(MOCK_PASSWORD, NEW_PASSWORD, `${NEW_PASSWORD}-typo`);
    await submitPassword();
    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(calls).toBe(0);
  });

  it('never puts a password in the address', async () => {
    await openProfile();

    await fillPasswords(MOCK_PASSWORD, NEW_PASSWORD);
    await submitPassword();
    await screen.findByText(/^Your password has been changed\./);

    expect(window.location.href).not.toContain(NEW_PASSWORD);
  });
});
