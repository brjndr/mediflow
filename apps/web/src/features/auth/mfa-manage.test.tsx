import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_PASSWORD, setMockMfa, signOut as signOutOnServer, USER_IDS } from '@/mocks/db';
import {
  MOCK_MFA_CODE,
  MOCK_NEW_RECOVERY_CODES,
  setMockMfaAvailable,
  setMockMfaRequired,
} from '@/mocks/handlers/mfa';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { MFA_STEP_TIMEOUT_MS } from './components/LoginPage';
import { CLIPBOARD_CLEAR_MS } from './components/RecoveryCodes';

const ADMIN = 'admin@sample-hospital.test';

async function paste(label: RegExp, text: string) {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  await userEvent.click(field);
  await userEvent.paste(text);
}

beforeEach(() => {
  setMockMfaAvailable(true);
  setMockMfa(USER_IDS.admin, true);
});
afterEach(() => vi.useRealTimers());

const open = async (name: string) => {
  const app = renderApp({ entry: '/security' });
  await userEvent.click(await screen.findByRole('button', { name }));
  return app;
};
const fill = async (password: string, code: string) => {
  await paste(/^Password/, password);
  await paste(/^Code from the app/, code);
};
const showNewCodes = async () => {
  const app = await open('Replace recovery codes');
  await fill(MOCK_PASSWORD, MOCK_MFA_CODE);
  await userEvent.click(screen.getByRole('button', { name: 'Replace codes' }));
  await screen.findByRole('list', { name: 'Recovery codes' });
  return app;
};

describe('replacing the recovery codes', () => {
  it('shows the new codes after the password and a code', async () => {
    await showNewCodes();

    const list = screen.getByRole('list', { name: 'Recovery codes' });
    for (const code of MOCK_NEW_RECOVERY_CODES) expect(list).toHaveTextContent(code);
  });

  it('refuses a wrong password and clears both fields', async () => {
    await open('Replace recovery codes');
    await fill('not-the-password', MOCK_MFA_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Replace codes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct');
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
    expect(screen.getByLabelText(/^Code from the app/)).toHaveValue('');
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
  });

  it('refuses a wrong code and clears both fields', async () => {
    await open('Replace recovery codes');
    await fill(MOCK_PASSWORD, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Replace codes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not correct');
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
    expect(screen.getByLabelText(/^Code from the app/)).toHaveValue('');
  });

  it('holds the person on the page until they say the codes are saved', async () => {
    const { router } = await showNewCodes();

    const link = document.createElement('a');
    link.href = '/profile';
    link.textContent = 'elsewhere';
    document.body.append(link);
    await userEvent.click(link);
    link.remove();

    expect(await screen.findByRole('alert')).toHaveTextContent('shown only once');
    expect(router.state.location.pathname).toBe('/security');

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole('checkbox', { name: 'I have saved these codes' }));
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('empties the clipboard after a minute', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await showNewCodes();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await userEvent.click(screen.getByRole('button', { name: 'Copy codes' }));
    expect(writeText).toHaveBeenLastCalledWith(MOCK_NEW_RECOVERY_CODES.join('\n'));
    await act(async () => {
      vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS);
    });

    expect(writeText).toHaveBeenLastCalledWith('');
    expect(screen.queryByText('Copied.')).toBeNull();
  });

  it('empties the clipboard when the screen is left', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { unmount } = await showNewCodes();
    await userEvent.click(screen.getByRole('button', { name: 'Copy codes' }));

    unmount();

    expect(writeText).toHaveBeenLastCalledWith('');
  });

  it('has no accessibility violations', async () => {
    const { container } = await open('Replace recovery codes');
    await screen.findByLabelText(/^Password/);
    await expectNoAxeViolations(container);
  });
});

describe('turning the authenticator off', () => {
  it('turns it off with the password and a code, and the page follows', async () => {
    await open('Turn off authenticator');
    await fill(MOCK_PASSWORD, MOCK_MFA_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));

    expect(await screen.findByText('The authenticator is turned off.')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Set up authenticator' })).toBeVisible();
  });

  it.each([
    ['a wrong password', 'not-the-password', MOCK_MFA_CODE, 'That password is not correct'],
    ['a wrong code', MOCK_PASSWORD, '000000', 'That code is not correct'],
  ])('refuses %s and leaves it on', async (_name, password, code, message) => {
    await open('Turn off authenticator');
    await fill(password, code);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
    expect(screen.getByLabelText(/^Code from the app/)).toHaveValue('');
    expect(screen.queryByText('The authenticator is turned off.')).toBeNull();
  });

  it('is refused where the hospital requires an authenticator', async () => {
    setMockMfaRequired(true);
    await open('Turn off authenticator');
    await fill(MOCK_PASSWORD, MOCK_MFA_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('requires an authenticator');
  });

  it('can be cancelled, and focus goes back to the button', async () => {
    await open('Turn off authenticator');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Turn off authenticator' })).toHaveFocus(),
    );
  });
});

describe('an abandoned code step at sign-in', () => {
  it('drops the held password after the time limit and says why', async () => {
    cleanup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signOutOnServer();
    renderApp({ entry: '/login' });
    await paste(/^Email/, ADMIN);
    await paste(/^Password/, MOCK_PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByLabelText(/^Code/);

    await act(async () => {
      vi.advanceTimersByTime(MFA_STEP_TIMEOUT_MS);
    });

    expect(screen.getByRole('status')).toHaveTextContent('timed out');
    expect(screen.queryByLabelText(/^Code/)).toBeNull();
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
  });
});
