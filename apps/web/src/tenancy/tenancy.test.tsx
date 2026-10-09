import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { sessionKey } from '@/app/session';
import { setSidebarCollapsed } from '@/app/ui-slice';
import { signIn, switchTenant as switchMockTenant, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { apiFetch, createTenantKeys, TENANT_HEADER } from '@/shared/api';
import { renderApp } from '@/test/render';

const HOME = { name: 'Hospital management system' };
const ECHO_URL = 'http://localhost:3000/api/echo';
const POLICY_URL = 'http://localhost:3000/api/session/policy';
const patientKeys = createTenantKeys('patients');

/** Keys of everything cached for any hospital. The session and system keys are not tenant data. */
const tenantDataKeys = (queryClient: QueryClient) =>
  queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter((key) => key[0] === 'tenant');

const switcher = () => screen.getByRole('combobox', { name: 'Hospital' });

/** Renders the app as the doctor who works at both hospitals, with the first one active. */
async function renderAsDoctorAtHospital() {
  signIn(USER_IDS.doctor, TENANT_IDS.hospital);
  const app = renderApp();
  await screen.findByRole('heading', HOME);
  return app;
}

describe('hospital picker', () => {
  it('asks a user with several hospitals to pick one, then opens the app there', async () => {
    signIn(USER_IDS.doctor);
    const { router } = renderApp({ entry: '/?tab=2' });
    expect(await screen.findByRole('heading', { name: 'Choose a hospital' })).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sample Hospital' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Riverside Clinic' }));

    await screen.findByRole('heading', HOME);
    expect(switcher()).toHaveValue(TENANT_IDS.clinic);
    expect(screen.queryByRole('heading', { name: 'Choose a hospital' })).not.toBeInTheDocument();
    // The address the user asked for is kept.
    expect(router.state.location.search).toBe('?tab=2');
  });

  it('shows an error and stays on the picker when the switch is refused', async () => {
    signIn(USER_IDS.doctor);
    server.use(
      http.post('*/api/session/switch-tenant', () =>
        HttpResponse.json(
          { error: { code: 'not_a_member', message: 'user 42 has no row in memberships' } },
          { status: 403 },
        ),
      ),
    );
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Riverside Clinic' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You do not have access to this.');
    expect(alert).not.toHaveTextContent('memberships');
    expect(screen.getByRole('heading', { name: 'Choose a hospital' })).toBeInTheDocument();
  });
});

describe('header switcher', () => {
  it('shows only the hospital name to a user with one hospital', async () => {
    renderApp();
    await screen.findByRole('heading', HOME);
    expect(screen.getByRole('banner')).toHaveTextContent('Sample Hospital');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('lists the user’s hospitals with the active one selected', async () => {
    await renderAsDoctorAtHospital();
    expect(switcher()).toHaveValue(TENANT_IDS.hospital);
    const options = within(switcher()).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Sample Hospital',
      'Riverside Clinic',
    ]);
  });

  it('leaves no data from the previous hospital after switching', async () => {
    const { queryClient, store, router } = await renderAsDoctorAtHospital();

    // State built up while working in the first hospital.
    const oldList = patientKeys.list(TENANT_IDS.hospital, { search: 'a' });
    const oldDetail = patientKeys.detail(TENANT_IDS.hospital, 'pat_1');
    queryClient.setQueryData(oldList, { items: [{ id: 'pat_1' }], nextCursor: null });
    queryClient.setQueryData(oldDetail, { id: 'pat_1', tenantId: TENANT_IDS.hospital });
    store.dispatch(setSidebarCollapsed(true));
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => Promise.resolve({ id: 'pat_2' }) })
      .execute(undefined);
    let inFlightAborted = false;
    const inFlight = queryClient
      .fetchQuery({
        queryKey: patientKeys.detail(TENANT_IDS.hospital, 'pat_slow'),
        queryFn: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              inFlightAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      })
      .catch(() => undefined);
    const headers: (string | null)[] = [];
    server.use(
      http.get(ECHO_URL, ({ request }) => {
        headers.push(request.headers.get(TENANT_HEADER));
        return HttpResponse.json({});
      }),
    );
    await apiFetch(ECHO_URL);

    await userEvent.selectOptions(switcher(), TENANT_IDS.clinic);
    await waitFor(() => expect(switcher()).toHaveValue(TENANT_IDS.clinic));
    await inFlight;

    // Nothing keyed to the previous hospital is left anywhere in the query cache.
    expect(tenantDataKeys(queryClient)).toEqual([]);
    const remaining = queryClient.getQueryCache().getAll();
    expect(JSON.stringify(remaining.map((query) => query.state.data))).not.toContain('pat_1');
    expect(queryClient.getQueryData(oldList)).toBeUndefined();
    expect(queryClient.getQueryData(oldDetail)).toBeUndefined();
    // Mutation results are gone too, apart from the switch itself.
    const mutations = queryClient.getMutationCache().getAll();
    expect(JSON.stringify(mutations.map((mutation) => mutation.state.data))).not.toContain('pat_2');
    // In-flight work was aborted and client state reset.
    expect(inFlightAborted).toBe(true);
    expect(store.getState().ui.sidebarCollapsed).toBe(false);
    // The session, config and policy are the new hospital's.
    expect(queryClient.getQueryData(sessionKey)).toMatchObject({
      activeTenant: { id: TENANT_IDS.clinic, currency: 'AED' },
      policy: { tenantId: TENANT_IDS.clinic },
    });
    // Later requests carry the new tenant, and the user is back on the home route.
    await apiFetch(ECHO_URL);
    expect(headers).toEqual([TENANT_IDS.hospital, TENANT_IDS.clinic]);
    expect(router.state.location.pathname).toBe('/');
    // The tab that switched does not tell itself the hospital changed elsewhere.
    expect(screen.queryByText(/changed in another tab/)).not.toBeInTheDocument();
  });

  it('keeps the current hospital and its cache when the switch is refused', async () => {
    const { queryClient, store } = await renderAsDoctorAtHospital();
    const key = patientKeys.detail(TENANT_IDS.hospital, 'pat_1');
    queryClient.setQueryData(key, { id: 'pat_1' });
    store.dispatch(setSidebarCollapsed(true));
    server.use(
      http.post('*/api/session/switch-tenant', async () => {
        await delay(30);
        return new HttpResponse(null, { status: 403 });
      }),
    );

    await userEvent.selectOptions(switcher(), TENANT_IDS.clinic);
    expect(switcher()).toBeDisabled();
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to this.');

    expect(switcher()).toBeEnabled();
    expect(switcher()).toHaveValue(TENANT_IDS.hospital);
    expect(queryClient.getQueryData(key)).toEqual({ id: 'pat_1' });
    expect(store.getState().ui.sidebarCollapsed).toBe(true);
  });
});

describe('hospital changed in another tab', () => {
  /** What another tab does: the server-side session moves to the other hospital. */
  const switchElsewhere = () => switchMockTenant(TENANT_IDS.clinic);

  async function expectResynced(app: Awaited<ReturnType<typeof renderAsDoctorAtHospital>>) {
    await waitFor(() => expect(switcher()).toHaveValue(TENANT_IDS.clinic));
    expect(screen.getByText(/changed in another tab/)).toBeInTheDocument();
    expect(tenantDataKeys(app.queryClient)).toEqual([]);
    expect(app.store.getState().ui.sidebarCollapsed).toBe(false);
  }

  it('reloads the session when the API rejects a stale tenant header', async () => {
    const app = await renderAsDoctorAtHospital();
    app.queryClient.setQueryData(patientKeys.detail(TENANT_IDS.hospital, 'pat_1'), { id: 'pat_1' });
    app.store.dispatch(setSidebarCollapsed(true));
    switchElsewhere();

    // This tab still sends the old tenant, so the server refuses the request.
    await expect(apiFetch(POLICY_URL)).rejects.toMatchObject({
      code: 'conflict',
      serverCode: 'tenant_mismatch',
    });

    await expectResynced(app);
    // The next request carries the new tenant and is accepted.
    await expect(apiFetch(POLICY_URL)).resolves.toHaveProperty('status', 200);
  });

  it('reloads the session as soon as the other tab announces the switch', async () => {
    const app = await renderAsDoctorAtHospital();
    app.queryClient.setQueryData(patientKeys.detail(TENANT_IDS.hospital, 'pat_1'), { id: 'pat_1' });
    app.store.dispatch(setSidebarCollapsed(true));
    switchElsewhere();

    const otherTab = new BroadcastChannel('mediflow.session');
    otherTab.postMessage('session-changed');
    otherTab.close();

    await expectResynced(app);
  });

  it('lets the user dismiss the notice', async () => {
    const app = await renderAsDoctorAtHospital();
    switchElsewhere();
    await expect(apiFetch(POLICY_URL)).rejects.toMatchObject({ serverCode: 'tenant_mismatch' });
    await expectResynced(app);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/changed in another tab/)).not.toBeInTheDocument();
  });
});

describe('createTenantKeys', () => {
  it('prefixes every key with the tenant, so two hospitals never share one', () => {
    const filters = { search: 'a' };
    expect(patientKeys.all('t1')).toEqual(['tenant', 't1', 'patients']);
    expect(patientKeys.lists('t1')).toEqual(['tenant', 't1', 'patients', 'list']);
    expect(patientKeys.list('t1', filters)).toEqual(['tenant', 't1', 'patients', 'list', filters]);
    expect(patientKeys.details('t1')).toEqual(['tenant', 't1', 'patients', 'detail']);
    expect(patientKeys.detail('t1', 'p1')).toEqual(['tenant', 't1', 'patients', 'detail', 'p1']);
    expect(patientKeys.detail('t1', 'p1')).not.toEqual(patientKeys.detail('t2', 'p1'));
  });
});
