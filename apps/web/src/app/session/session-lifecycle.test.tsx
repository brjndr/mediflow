import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentSession,
  MOCK_PASSWORD,
  setTenantIdleTimeout,
  signIn,
  signOut as signOutOnServer,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { createTestQueryClient, renderApp } from '@/test/render';
import { SESSION_CHANNEL_NAME, type SessionMessage } from './session-channel';
import { sessionKey } from './session-query';

/**
 * How a session ends: nobody at the screen, the server, or another tab. Idle times here are a
 * second or so (the mock accepts fractions of a minute) so the tests run on the real clock.
 */

const HOME = { name: 'Hospital management system' };
const SIGN_IN = { name: 'Sign in' };
const STILL_THERE = { name: 'Are you still there?' };
/** 1.2 seconds, with the warning for the last 0.6. */
const SHORT = 0.02;
const SHORT_MS = SHORT * 60_000;

const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const tenantData = (queryClient: ReturnType<typeof createTestQueryClient>) =>
  queryClient.getQueryCache().findAll({ queryKey: ['tenant'] });

/** Another tab of the same browser. */
const otherTabs: BroadcastChannel[] = [];
function fromAnotherTab(message: SessionMessage | 'something-else') {
  const tab = new BroadcastChannel(SESSION_CHANNEL_NAME);
  otherTabs.push(tab);
  tab.postMessage(message);
}
afterEach(() => {
  for (const tab of otherTabs.splice(0)) tab.close();
});

function countRequests(method: string, path: string) {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === method && new URL(request.url).pathname === path) seen.push(path);
  });
  return seen;
}

async function openNotices() {
  const queryClient = createTestQueryClient();
  const app = renderApp({ entry: '/notices', queryClient });
  await screen.findByRole('heading', { name: 'Staff notices' });
  return { ...app, queryClient };
}

describe('nobody at the screen', () => {
  it('warns first, then signs out and clears everything that was loaded', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    const { queryClient, router } = await openNotices();
    expect(tenantData(queryClient).length).toBeGreaterThan(0);

    const warning = await screen.findByRole('heading', STILL_THERE);
    expect(warning.closest('dialog')).toHaveAttribute('role', 'alertdialog');
    expect(screen.getByText(/You will be signed out in \d+ seconds?/)).toBeInTheDocument();

    expect(await screen.findByRole('heading', SIGN_IN)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'You were signed out because the app was not used for a while.',
    );
    expect(tenantData(queryClient)).toEqual([]);
    expect(screen.queryByText(/Hospital notice/)).not.toBeInTheDocument();
    // The server was told too, and the address of the open screen was not kept.
    await waitFor(() => expect(currentSession()).toBeNull());
    expect(router.state.location).toMatchObject({ pathname: '/login', state: null });
  });

  it('does not take the next person to sign in to the screen that was open', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    const { router } = await openNotices();
    await screen.findByRole('heading', SIGN_IN);

    await userEvent.click(screen.getByLabelText(/^Email/));
    await userEvent.paste('reception@riverside-clinic.test');
    await userEvent.click(screen.getByLabelText(/^Password/));
    await userEvent.paste(MOCK_PASSWORD);
    await userEvent.click(screen.getByRole('button', SIGN_IN));

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('clears the screen even when the server cannot be told', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    server.use(http.post('*/api/auth/logout', () => HttpResponse.error()));
    const { queryClient } = await openNotices();

    expect(await screen.findByRole('heading', SIGN_IN)).toBeInTheDocument();
    expect(tenantData(queryClient)).toEqual([]);
  });

  it('uses each hospital’s own idle time', async () => {
    // The clinic's is short; the hospital keeps the usual half hour.
    setTenantIdleTimeout(TENANT_IDS.clinic, SHORT);
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp();
    await screen.findByRole('heading', HOME);

    await pause(SHORT_MS + 300);
    expect(screen.getByRole('heading', HOME)).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    expect(await screen.findByRole('heading', STILL_THERE)).toBeInTheDocument();
    expect(await screen.findByRole('heading', SIGN_IN)).toBeInTheDocument();
  });
});

describe('someone at the screen', () => {
  it('is not signed out while they keep working', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();

    for (let elapsed = 0; elapsed < SHORT_MS * 2; elapsed += 200) {
      fireEvent.keyDown(window, { key: 'a' });
      await pause(200);
    }

    expect(screen.queryByRole('heading', STILL_THERE)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
  });

  it('keeps the session alive on the server while they work without making requests', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();
    const sessionReads = countRequests('GET', '/api/session');

    for (let elapsed = 0; elapsed < SHORT_MS; elapsed += 150) {
      fireEvent.pointerDown(window);
      await pause(150);
    }

    expect(sessionReads.length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
  });

  it('can answer the warning and carry on', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();
    const sessionReads = countRequests('GET', '/api/session');
    await screen.findByRole('heading', STILL_THERE);

    // Staying has focus, so Enter pressed out of habit keeps the session rather than ending it.
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(screen.queryByRole('heading', STILL_THERE)).not.toBeInTheDocument();
    // The server hears about it, so its own idle clock starts again as well.
    await waitFor(() => expect(sessionReads.length).toBeGreaterThan(0));
    await pause(SHORT_MS / 2 - 200);
    expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
    expect(currentSession()).not.toBeNull();
  });

  it('has to answer the warning: a stray key press does not keep an unattended screen open', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();
    await screen.findByRole('heading', STILL_THERE);

    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.pointerDown(window);

    expect(screen.getByRole('heading', STILL_THERE)).toBeInTheDocument();
    expect(await screen.findByRole('heading', SIGN_IN)).toBeInTheDocument();
  });

  it('treats Escape on the warning as "I am here"', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();
    const dialog = (await screen.findByRole('heading', STILL_THERE)).closest('dialog');
    if (!dialog) throw new Error('no dialog');

    // What the browser sends when Escape is pressed on a modal dialog.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    await waitFor(() => expect(screen.queryByRole('heading', STILL_THERE)).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
  });

  it('can sign out from the warning, which is not reported as inactivity', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();
    await screen.findByRole('heading', STILL_THERE);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out now' }));

    expect(await screen.findByRole('heading', SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => expect(currentSession()).toBeNull());
  });
});

describe('other tabs of the same browser', () => {
  it('count as activity: working in one tab keeps the others signed in', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();
    await screen.findByRole('heading', STILL_THERE);

    fromAnotherTab('activity');

    await waitFor(() => expect(screen.queryByRole('heading', STILL_THERE)).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
  });

  it('are told when this tab is in use', async () => {
    setTenantIdleTimeout(TENANT_IDS.hospital, SHORT);
    await openNotices();
    const heard: unknown[] = [];
    const tab = new BroadcastChannel(SESSION_CHANNEL_NAME);
    otherTabs.push(tab);
    tab.addEventListener('message', (event) => heard.push(event.data));

    await pause(250);
    fireEvent.keyDown(window, { key: 'a' });

    await waitFor(() => expect(heard).toContain('activity'));
  });

  it('sign this tab out when the user signs out there', async () => {
    const { queryClient, router } = await openNotices();

    // The other tab ended the session on the server, then told this one.
    signOutOnServer();
    fromAnotherTab('signed-out');

    expect(await screen.findByRole('heading', SIGN_IN)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You signed out in another tab.');
    expect(tenantData(queryClient)).toEqual([]);
    expect(router.state.location).toMatchObject({ pathname: '/login', state: null });
  });

  it('sign this tab in when the user signs in there', async () => {
    signOutOnServer();
    renderApp();
    await screen.findByRole('heading', SIGN_IN);

    // The other tab signed in: the cookie is shared, so the server now knows this browser.
    signIn(USER_IDS.admin);
    fromAnotherTab('signed-in');

    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByText('Sample Admin')).toBeInTheDocument();
  });

  it('never leave one user’s data on screen when another signs in there', async () => {
    const { queryClient } = await openNotices();
    queryClient.setQueryData(['tenant', TENANT_IDS.hospital, 'patients'], ['admin data']);

    signIn(USER_IDS.receptionist);
    fromAnotherTab('signed-in');

    await waitFor(() =>
      expect(
        within(screen.getByRole('banner')).getByText('Sample Receptionist'),
      ).toBeInTheDocument(),
    );
    expect(queryClient.getQueryData(['tenant', TENANT_IDS.hospital, 'patients'])).toBeUndefined();
  });

  it('are not obeyed when they say something else', async () => {
    await openNotices();

    fromAnotherTab('something-else');
    await pause(100);

    expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
  });

  it('do not mistake a sign-in for a change of hospital', async () => {
    await openNotices();

    fromAnotherTab('signed-in');
    await pause(150);

    expect(
      screen.queryByText(/The active hospital was changed in another tab/),
    ).not.toBeInTheDocument();
  });
});

describe('a session the server has ended', () => {
  it('sends the user to login with an explanation, and keeps nothing', async () => {
    const { queryClient, router } = await openNotices();
    // Its time ran out, or an admin revoked it.
    signOutOnServer();

    // The next request this tab makes is refused.
    await act(() => queryClient.invalidateQueries({ queryKey: ['tenant'] }));

    expect(await screen.findByRole('heading', SIGN_IN)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your session has ended. Sign in again to continue.',
    );
    expect(tenantData(queryClient)).toEqual([]);
    // They were at work, so signing in again takes them back to where they were.
    expect(router.state.location).toMatchObject({
      pathname: '/login',
      state: { from: '/notices' },
    });
  });

  it('is not what a first visit or a refused sign-in looks like', async () => {
    signOutOnServer();
    renderApp();
    await screen.findByRole('heading', SIGN_IN);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/^Email/));
    await userEvent.paste('admin@sample-hospital.test');
    await userEvent.click(screen.getByLabelText(/^Password/));
    await userEvent.paste('not the right password');
    await userEvent.click(screen.getByRole('button', SIGN_IN));

    await screen.findByRole('alert');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stops explaining once someone has signed in again', async () => {
    await openNotices();
    signOutOnServer();
    fromAnotherTab('signed-out');
    await screen.findByRole('heading', SIGN_IN);
    expect(screen.getByRole('status')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/^Email/));
    await userEvent.paste('admin@sample-hospital.test');
    await userEvent.click(screen.getByLabelText(/^Password/));
    await userEvent.paste(MOCK_PASSWORD);
    await userEvent.click(screen.getByRole('button', SIGN_IN));
    await screen.findByRole('heading', HOME);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', SIGN_IN);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('signing out from a public page', () => {
  it('ends the session without leaving the page, so an emailed link keeps its address', async () => {
    const { router, queryClient } = renderApp({ entry: '/forgot-password' });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out and continue' }));

    await screen.findByRole('heading', { name: 'Forgot your password?' });
    expect(router.state.location.pathname).toBe('/forgot-password');
    expect(queryClient.getQueryData(sessionKey)).toBeNull();
  });
});
