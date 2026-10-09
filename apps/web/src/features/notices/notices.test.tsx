import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import {
  revokePermission,
  sessionFor,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { appRegistry, Slot } from '@/registry';
import { api } from '@/shared/api';
import type { AccessPolicy } from '@/shared/types';
import { renderApp, renderWithProviders } from '@/test/render';
import { noticeKeys } from './hooks/use-notices';
import { noticesSettingsSchema } from './settings';

const HEADING = { name: 'Staff notices' };
const NO_ACCESS = { name: 'You do not have access to this page' };

const noticeTitles = () =>
  within(screen.getByRole('main'))
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);
const navLink = () => screen.queryByRole('link', { name: 'Notices' });
const archiveButtons = () => screen.queryAllByRole('button', { name: /^Archive/ });
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });

/** Counts requests to the notices endpoint, then lets the mock backend answer. */
function watchNoticeRequests() {
  const requests: string[] = [];
  server.use(
    http.get('*/api/notices', ({ request }) => {
      requests.push(new URL(request.url).search);
      return undefined;
    }),
  );
  return requests;
}

describe('notices page', () => {
  it('is reached from the generated nav and lists notices one page at a time', async () => {
    const requests = watchNoticeRequests();
    renderApp();
    await home();

    await userEvent.click(screen.getByRole('link', { name: 'Notices' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));
    expect(noticeTitles()[0]).toBe('Hospital notice 1');

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(noticeTitles()).toHaveLength(30));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    // Two server pages, never the whole list in one request.
    expect(requests).toEqual(['?limit=25', '?cursor=ntc_h_26&limit=25']);
  });

  it('shows dates in the hospital’s locale and timezone', async () => {
    renderApp({ entry: '/notices' });
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));
    // 2026-10-01T04:30Z is 10:00 in Asia/Kolkata.
    expect(screen.getByText(/Posted 1 Oct 2026, 10:00/)).toBeInTheDocument();
  });

  it('archives a notice and removes it from the list', async () => {
    renderApp({ entry: '/notices' });
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));

    await userEvent.click(screen.getByRole('button', { name: 'Archive “Hospital notice 1”' }));

    await waitFor(() => expect(noticeTitles()[0]).toBe('Hospital notice 2'));
    expect(noticeTitles()).not.toContain('Hospital notice 1');
  });

  it('shows the empty state', async () => {
    server.use(http.get('*/api/notices', () => HttpResponse.json({ items: [], nextCursor: null })));
    renderApp({ entry: '/notices' });
    expect(await screen.findByText('There are no notices right now.')).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows a friendly error with a retry, never the server message', async () => {
    server.use(
      http.get('*/api/notices', () =>
        HttpResponse.json(
          { error: { code: 'internal', message: 'relation "notices" does not exist' } },
          { status: 500 },
        ),
      ),
    );
    renderApp({ entry: '/notices' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side');
    expect(alert).not.toHaveTextContent('relation');

    server.resetHandlers();
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));
  });

  it('treats a malformed response as an error instead of rendering it', async () => {
    server.use(
      http.get('*/api/notices', () =>
        HttpResponse.json({ items: [{ id: 'ntc_x', title: 42 }], nextCursor: null }),
      ),
    );
    renderApp({ entry: '/notices' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });
});

describe('permission absent', () => {
  it('hides the archive action from a role that can only read', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/notices' });
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));
    expect(archiveButtons()).toHaveLength(0);
  });

  it('shows the archive action to a role that can manage', async () => {
    renderApp({ entry: '/notices' });
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));
    expect(archiveButtons()).toHaveLength(25);
  });

  it('hides the nav item and blocks the page without notice:read', async () => {
    const requests = watchNoticeRequests();
    revokePermission(TENANT_IDS.hospital, 'doctor', 'notice:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/notices' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(navLink()).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('is enforced by the API too, whatever the UI shows', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await expect(
      api.POST('/notices/{noticeId}/archive', { params: { path: { noticeId: 'ntc_h_01' } } }),
    ).rejects.toMatchObject({ code: 'forbidden', serverCode: 'permission_denied' });
  });
});

describe('feature flag off', () => {
  it('hides everything: nav, page, widget, settings, and makes no request', async () => {
    const requests = watchNoticeRequests();
    // The clinic has the notices flag off, and its doctors hold notice:read.
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    const clinicPolicy = sessionFor(USER_IDS.doctor, TENANT_IDS.clinic).policy as AccessPolicy;
    expect(clinicPolicy.permissions.map((grant) => grant.permission)).toContain('notice:read');

    renderApp({ entry: '/notices' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('heading', HEADING)).not.toBeInTheDocument();
    expect(navLink()).not.toBeInTheDocument();
    expect(appRegistry.contributions('dashboard.widgets', clinicPolicy)).toEqual([]);
    expect(appRegistry.settingsSections(clinicPolicy)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('is enforced by the API too', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    await expect(api.GET('/notices')).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });

  it('appears as soon as the flag is on for the hospital', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'notices', true);
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/notices' });
    await waitFor(() => expect(noticeTitles()).toEqual(['Clinic notice 1', 'Clinic notice 2']));
    expect(navLink()).toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s notices in the other', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'notices', true);
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = renderApp({ entry: '/notices' });
    await waitFor(() => expect(noticeTitles()).toHaveLength(25));
    expect(
      queryClient.getQueryCache().findAll({ queryKey: noticeKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await home();
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: noticeKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/notices');
    await waitFor(() => expect(noticeTitles()).toEqual(['Clinic notice 1', 'Clinic notice 2']));
    expect(screen.queryByText(/Hospital notice/)).not.toBeInTheDocument();
  });

  it('cannot archive another hospital’s notice', async () => {
    // The admin belongs to the hospital only. A clinic notice id does not exist for them.
    await expect(
      api.POST('/notices/{noticeId}/archive', { params: { path: { noticeId: 'ntc_c_01' } } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('plug-in contributions', () => {
  it('contributes a widget to the dashboard slot', async () => {
    renderWithProviders(<Slot id="dashboard.widgets" />);
    const widget = await screen.findByRole('region', { name: 'Latest notices' });
    await waitFor(() => expect(within(widget).getAllByRole('listitem')).toHaveLength(3));
    expect(within(widget).getByText('Hospital notice 1')).toBeInTheDocument();
  });

  it('declares a settings section for roles that can manage notices', async () => {
    const admin = sessionFor(USER_IDS.admin).policy as AccessPolicy;
    const doctor = sessionFor(USER_IDS.doctor, TENANT_IDS.hospital).policy as AccessPolicy;
    expect(appRegistry.settingsSections(admin).map((section) => section.section)).toEqual([
      'notices',
    ]);
    expect(appRegistry.settingsSections(doctor)).toEqual([]);
  });

  it('validates its settings', () => {
    expect(noticesSettingsSchema.parse({})).toEqual({ widgetCount: 3 });
    expect(noticesSettingsSchema.safeParse({ widgetCount: 5 }).success).toBe(true);
    expect(noticesSettingsSchema.safeParse({ widgetCount: 0 }).success).toBe(false);
    expect(noticesSettingsSchema.safeParse({ widgetCount: 2.5 }).success).toBe(false);
    expect(noticesSettingsSchema.safeParse({ widgetCount: 11 }).success).toBe(false);
  });
});
