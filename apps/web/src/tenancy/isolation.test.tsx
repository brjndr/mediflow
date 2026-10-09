import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { noticeKeys } from '@/features/notices/hooks/use-notices';
import {
  sessionFor,
  setRolePermissions,
  setTenantFeature,
  setTenantStatus,
  signIn,
  switchTenant as switchMockTenant,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { apiFetch, createTenantKeys, TENANT_HEADER } from '@/shared/api';
import { renderApp, renderWithProviders } from '@/test/render';
import { plainSpaces } from '@/test/text';
import { TenantSwitcher, useFormatters } from '.';
import { safeLogoUrl } from './logo-url';

/**
 * Tenant isolation under awkward timing: work that is still in flight when the hospital changes,
 * and repeated signals arriving while a resync is already under way. The plain cases are in
 * tenancy.test.tsx.
 */

const home = () => screen.findByRole('heading', { name: 'Hospital management system' });
const switcher = () => screen.getByRole('combobox', { name: 'Hospital' });
const noticeTitles = () =>
  within(screen.getByRole('main'))
    .queryAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);
const patientKeys = createTenantKeys('patients');

const tenantDataKeys = (queryClient: QueryClient) =>
  queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter((key) => key[0] === 'tenant');

/** Renders the notices page as the doctor at the hospital, with the clinic's module on too. */
async function renderNoticesAtHospital() {
  setTenantFeature(TENANT_IDS.clinic, 'notices', true);
  signIn(USER_IDS.doctor, TENANT_IDS.hospital);
  const app = renderApp({ entry: '/notices' });
  await waitFor(() => expect(noticeTitles()).toHaveLength(25));
  return app;
}

/** Counts session loads, then lets the mock backend answer. */
function watchSessionRequests() {
  let count = 0;
  server.use(
    http.get('*/api/session', () => {
      count++;
      return undefined;
    }),
  );
  return () => count;
}

describe('work in flight when the hospital changes', () => {
  it('drops a response for the previous hospital that arrives after the switch', async () => {
    const { queryClient } = await renderNoticesAtHospital();

    // A request for the first hospital that ignores cancellation and answers late.
    let answer: (value: unknown) => void = () => {};
    const lateKey = patientKeys.detail(TENANT_IDS.hospital, 'pat_late');
    const late = queryClient
      .fetchQuery({
        queryKey: lateKey,
        queryFn: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      })
      .catch(() => undefined);

    await userEvent.selectOptions(switcher(), TENANT_IDS.clinic);
    await home();
    answer({ id: 'pat_late', tenantId: TENANT_IDS.hospital, name: 'belongs to the hospital' });
    await late;

    // The late answer was not put back into the cache, under any key.
    expect(queryClient.getQueryData(lateKey)).toBeUndefined();
    expect(tenantDataKeys(queryClient)).toEqual([]);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('pat_late');
  });

  it('does not show the previous hospital’s list when its slow response lands after the switch', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'notices', true);
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    // The list is slow, so the switch happens while it is still loading.
    server.use(
      http.get('*/api/notices', async () => {
        await delay(120);
        return undefined;
      }),
    );
    const { router, queryClient } = renderApp({ entry: '/notices' });
    await screen.findByRole('heading', { name: 'Staff notices' });
    expect(noticeTitles()).toEqual([]);

    await userEvent.selectOptions(switcher(), TENANT_IDS.clinic);
    await home();
    await delay(200);
    expect(
      queryClient.getQueryCache().findAll({ queryKey: noticeKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/notices');
    await waitFor(() => expect(noticeTitles()).toEqual(['Clinic notice 1', 'Clinic notice 2']));
    expect(screen.queryByText(/Hospital notice/)).not.toBeInTheDocument();
  });

  it('keeps a mutation that finishes after the switch out of every cache', async () => {
    // Doctors can only read notices by default. Let them archive at the hospital for this test.
    const doctorGrants = sessionFor(USER_IDS.doctor, TENANT_IDS.hospital).policy?.permissions ?? [];
    setRolePermissions(TENANT_IDS.hospital, 'doctor', [
      ...doctorGrants,
      { permission: 'notice:manage' },
    ]);
    const { queryClient, router } = await renderNoticesAtHospital();

    const afterSwitch: (string | null)[] = [];
    let switched = false;
    let release: () => void = () => {};
    server.use(
      http.post('*/api/notices/:noticeId/archive', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      }),
      http.get('*/api/notices', ({ request }) => {
        if (switched) afterSwitch.push(request.headers.get(TENANT_HEADER));
        return undefined;
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Archive “Hospital notice 1”' }));
    // The user switches hospital while the archive request is still on its way.
    await userEvent.selectOptions(switcher(), TENANT_IDS.clinic);
    await home();
    switched = true;

    release();
    await delay(60);

    // When it finished, it refetched nothing for the hospital it belonged to, and put nothing
    // into the cache.
    expect(afterSwitch).toEqual([]);
    expect(tenantDataKeys(queryClient)).toEqual([]);

    // The clinic's own list is unaffected.
    await router.navigate('/notices');
    await waitFor(() => expect(noticeTitles()).toEqual(['Clinic notice 1', 'Clinic notice 2']));
    expect(afterSwitch).toEqual([TENANT_IDS.clinic]);
  });

  it('leaves no feature data behind when the session ends on a real screen', async () => {
    const { queryClient, router } = await renderNoticesAtHospital();
    expect(tenantDataKeys(queryClient)).not.toEqual([]);

    // The next page request finds the session gone.
    server.use(http.get('*/api/notices', () => new HttpResponse(null, { status: 401 })));
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.state).toEqual({ from: '/notices' });
    await waitFor(() => expect(tenantDataKeys(queryClient)).toEqual([]));
    expect(screen.queryByText(/Hospital notice/)).not.toBeInTheDocument();
  });
});

describe('repeated signals', () => {
  it('reloads the session once when several stale requests are rejected together', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp();
    await home();
    const sessionLoads = watchSessionRequests();
    switchMockTenant(TENANT_IDS.clinic);

    const policy = 'http://localhost:3000/api/session/policy';
    await Promise.allSettled([apiFetch(policy), apiFetch(policy), apiFetch(policy)]);

    await waitFor(() => expect(switcher()).toHaveValue(TENANT_IDS.clinic));
    expect(sessionLoads()).toBe(1);
  });

  it('ignores unrelated messages on the session channel', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp();
    await home();
    const sessionLoads = watchSessionRequests();

    const otherTab = new BroadcastChannel('mediflow.session');
    otherTab.postMessage('something-else');
    otherTab.postMessage({ type: 'session-changed' });
    otherTab.close();
    await delay(60);

    expect(sessionLoads()).toBe(0);
    expect(screen.queryByText(/changed in another tab/)).not.toBeInTheDocument();
  });

  it('reloads the session once when several requests report a suspended hospital', async () => {
    renderApp({ entry: '/notices' });
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));
    const sessionLoads = watchSessionRequests();
    setTenantStatus(TENANT_IDS.hospital, 'suspended');

    const notices = 'http://localhost:3000/api/notices';
    await Promise.allSettled([apiFetch(notices), apiFetch(notices)]);

    expect(
      await screen.findByRole('heading', { name: 'Sample Hospital is suspended' }),
    ).toBeInTheDocument();
    expect(sessionLoads()).toBe(1);
  });
});

describe('without an active hospital', () => {
  it('renders no switcher', async () => {
    renderWithProviders(
      <div data-testid="host">
        <TenantSwitcher />
      </div>,
      { session: null },
    );
    expect(await screen.findByTestId('host')).toBeEmptyDOMElement();
  });

  it('formats with neutral defaults instead of any hospital’s settings', async () => {
    function Sample() {
      const format = useFormatters();
      return <output>{format.dateTime('2026-10-14T20:15:00Z')}</output>;
    }
    renderWithProviders(<Sample />, { session: null });
    expect(plainSpaces((await screen.findByRole('status')).textContent)).toBe(
      'Oct 14, 2026, 8:15 PM',
    );
  });

  it('treats a logo URL that cannot be parsed as no logo', () => {
    expect(safeLogoUrl('https://[not-a-host')).toBeUndefined();
    expect(safeLogoUrl('')).toBeUndefined();
  });
});
