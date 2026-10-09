import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { sessionFor, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { apiFetch, TENANT_HEADER } from '@/shared/api';
import { renderApp } from '@/test/render';
import { setSidebarCollapsed } from '../ui-slice';
import { fetchSession } from './api';
import { sessionKey } from './session-query';

const HOME = { name: 'Hospital management system' };
const SESSION_URL = '*/api/session';
const ECHO_URL = 'http://localhost:3000/api/echo';

const sampleSession = sessionFor(USER_IDS.admin);

const secondHospital = {
  ...sampleSession,
  activeTenant: { ...sampleSession.activeTenant!, id: 'tenant_2', name: 'Second Hospital' },
  policy: { ...sampleSession.policy!, tenantId: 'tenant_2' },
};

const unauthenticated = () =>
  HttpResponse.json({ error: { code: 'unauthenticated', message: 'No session' } }, { status: 401 });

/** Records the tenant header of every request to the echo endpoint. */
function recordTenantHeaders() {
  const seen: (string | null)[] = [];
  server.use(
    http.get(ECHO_URL, ({ request }) => {
      seen.push(request.headers.get(TENANT_HEADER));
      return HttpResponse.json({});
    }),
  );
  return seen;
}

describe('session bootstrap', () => {
  it('blocks rendering until the session resolves', async () => {
    server.use(
      http.get(SESSION_URL, async () => {
        await delay(50);
        return HttpResponse.json(sampleSession);
      }),
    );
    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your workspace');
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Sample Hospital');
  });

  it('sends unauthenticated users to login and remembers where they were going', async () => {
    server.use(http.get(SESSION_URL, unauthenticated));
    const { router } = renderApp({ entry: '/?tab=2' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('');
    expect(router.state.location.state).toEqual({ from: '/?tab=2' });
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });

  it('shows an error with a retry when the session cannot be loaded', async () => {
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json(
          { error: { code: 'internal', message: 'pg: connection refused at 10.0.0.5' } },
          { status: 500 },
        ),
      ),
    );
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your session');
    expect(alert).toHaveTextContent('Something went wrong on our side');
    expect(alert).not.toHaveTextContent('connection refused');
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();

    server.resetHandlers();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', HOME)).toBeInTheDocument();
  });

  it('drops the session and everything loaded under it when a request returns 401', async () => {
    const { queryClient, store, router } = renderApp();
    await screen.findByRole('heading', HOME);
    const patientsKey = ['tenant', 'tenant_1', 'patients', 'list'];
    queryClient.setQueryData(patientsKey, { items: [{ id: 'pat_1' }] });
    store.dispatch(setSidebarCollapsed(true));

    server.use(http.get(ECHO_URL, unauthenticated));
    await expect(apiFetch(ECHO_URL)).rejects.toMatchObject({ code: 'unauthorized' });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(queryClient.getQueryData(sessionKey)).toBeNull();
    await waitFor(() => expect(queryClient.getQueryData(patientsKey)).toBeUndefined());
    expect(store.getState().ui.sidebarCollapsed).toBe(false);
  });
});

describe('tenant from the session', () => {
  it('sends the active tenant as the consistency header once the session has loaded', async () => {
    const seen = recordTenantHeaders();
    renderApp();
    await screen.findByRole('heading', HOME);
    await apiFetch(ECHO_URL);
    expect(seen).toEqual(['tenant_1']);
  });

  it('follows the session when the active hospital changes', async () => {
    const seen = recordTenantHeaders();
    const { queryClient } = renderApp();
    await screen.findByRole('heading', HOME);
    expect(screen.getByRole('banner')).toHaveTextContent('Sample Hospital');
    await apiFetch(ECHO_URL);

    queryClient.setQueryData(sessionKey, secondHospital);
    await waitFor(() => expect(screen.getByRole('banner')).toHaveTextContent('Second Hospital'));
    expect(screen.getByRole('banner')).not.toHaveTextContent('Sample Hospital');
    await apiFetch(ECHO_URL);
    expect(seen).toEqual(['tenant_1', 'tenant_2']);
  });

  it('sends no tenant header and shows the picker while no hospital is active', async () => {
    const seen = recordTenantHeaders();
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json({ ...sampleSession, activeTenant: null, policy: null }),
      ),
    );
    renderApp();
    await screen.findByRole('heading', { name: 'Choose a hospital' });
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    await apiFetch(ECHO_URL);
    expect(seen).toEqual([null]);
  });
});

describe('login route', () => {
  it('returns a signed-in user to where they were going', async () => {
    const { router } = renderApp({ entry: { pathname: '/login', state: { from: '/?tab=2' } } });
    await screen.findByRole('heading', HOME);
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.search).toBe('?tab=2');
  });

  it.each(['//evil.test/path', 'https://evil.test', '/login', 42])(
    'ignores an unsafe intended path (%s)',
    async (from) => {
      const { router } = renderApp({ entry: { pathname: '/login', state: { from } } });
      await screen.findByRole('heading', HOME);
      expect(router.state.location.pathname).toBe('/');
      expect(router.state.location.search).toBe('');
    },
  );
});

describe('fetchSession', () => {
  it('resolves to null on a 401', async () => {
    server.use(http.get(SESSION_URL, unauthenticated));
    await expect(fetchSession()).resolves.toBeNull();
  });

  it('drops malformed permission grants instead of guessing', async () => {
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json({
          ...sampleSession,
          policy: {
            ...sampleSession.policy,
            permissions: [
              { permission: 'patient:read', scope: 'own' },
              { permission: 'admin' },
              { permission: 'a:b:c' },
            ],
          },
        }),
      ),
    );
    const session = await fetchSession();
    expect(session?.policy?.permissions).toEqual([{ permission: 'patient:read', scope: 'own' }]);
  });
});
