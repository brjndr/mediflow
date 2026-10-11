import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { activeTenantId, MOCK_PASSWORD, signIn, signOut, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { createTestQueryClient, renderApp } from '@/test/render';

/**
 * Deep links (`/open/<kind>/<id>`): the server finds the record's hospital and checks the user
 * works there. The mock has 30 notices at the hospital (`ntc_h_*`) and 2 at the clinic
 * (`ntc_c_*`), where the notices module is switched off.
 */

const OPEN_URL = '*/api/session/open-link';
const HOSPITAL_NOTICE = '/open/notice/ntc_h_01';
const CLINIC_NOTICE = '/open/notice/ntc_c_01';
const UNAVAILABLE = { name: 'This link is not available' };

/** Requests the page makes while a link is being opened. */
function watchRequests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return seen;
}

describe('opening a link to a record', () => {
  it('goes to the record at the hospital that is already open', async () => {
    signIn(USER_IDS.admin);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['tenant', TENANT_IDS.hospital, 'kept'], 1);

    const { router } = renderApp({ entry: HOSPITAL_NOTICE, queryClient });

    expect(await screen.findByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Hospital notice 1' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/notices');
    // Same hospital: nothing that was loaded needed to be thrown away.
    expect(queryClient.getQueryData(['tenant', TENANT_IDS.hospital, 'kept'])).toBe(1);
  });

  it('switches to the hospital that owns the record, dropping what the other one loaded', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['tenant', TENANT_IDS.clinic, 'patients'], ['clinic data']);

    const { router } = renderApp({ entry: HOSPITAL_NOTICE, queryClient });

    expect(await screen.findByRole('heading', { name: 'Hospital notice 1' })).toBeInTheDocument();
    expect(activeTenantId()).toBe(TENANT_IDS.hospital);
    expect(screen.getByRole('combobox', { name: 'Hospital' })).toHaveValue(TENANT_IDS.hospital);
    expect(queryClient.getQueryData(['tenant', TENANT_IDS.clinic, 'patients'])).toBeUndefined();
    expect(router.state.location.pathname).toBe('/notices');
  });

  it('needs no hospital picker: the link says where to go', async () => {
    signIn(USER_IDS.doctor);

    renderApp({ entry: HOSPITAL_NOTICE });

    expect(await screen.findByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose a hospital' })).not.toBeInTheDocument();
  });

  it('replaces the link in history, so Back does not open it again', async () => {
    signIn(USER_IDS.admin);

    const { router } = renderApp({ entry: HOSPITAL_NOTICE });

    await screen.findByRole('heading', { name: 'Staff notices' });
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('asks a signed-out visitor to sign in first, then opens the link', async () => {
    signOut();
    const { router } = renderApp({ entry: HOSPITAL_NOTICE });
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/login');

    await userEvent.click(screen.getByLabelText(/^Email/));
    await userEvent.paste('admin@sample-hospital.test');
    await userEvent.click(screen.getByLabelText(/^Password/));
    await userEvent.paste(MOCK_PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Hospital notice 1' })).toBeInTheDocument();
  });

  it('still leaves the screen to its own guard: a module that is off stays closed', async () => {
    // The doctor works at the clinic, so the link is honoured, but notices are off there.
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);

    renderApp({ entry: CLINIC_NOTICE });

    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(activeTenantId()).toBe(TENANT_IDS.clinic);
    expect(screen.queryByText(/Clinic notice/)).not.toBeInTheDocument();
  });
});

describe('a link that cannot be opened', () => {
  it('shows the same page for another hospital’s record and for one that does not exist', async () => {
    // The admin works at the hospital only.
    signIn(USER_IDS.admin);
    const first = renderApp({ entry: CLINIC_NOTICE });
    const heading = await screen.findByRole('heading', UNAVAILABLE);
    const foreign = heading.closest('main')?.textContent;
    first.unmount();

    renderApp({ entry: '/open/notice/ntc_x_99' });
    const missing = (await screen.findByRole('heading', UNAVAILABLE)).closest('main')?.textContent;

    expect(foreign).toBe(missing);
    expect(foreign).toContain('It may be for a hospital you do not work at');
  });

  it('shows no data and changes nothing', async () => {
    signIn(USER_IDS.admin);
    const requests = watchRequests();

    const { router } = renderApp({ entry: CLINIC_NOTICE });

    await screen.findByRole('heading', UNAVAILABLE);
    expect(screen.queryByText(/Clinic notice|Riverside Clinic/)).not.toBeInTheDocument();
    // Still at the hospital, and still at the link's own address: nothing of the record loaded.
    expect(activeTenantId()).toBe(TENANT_IDS.hospital);
    expect(router.state.location.pathname).toBe('/open/notice/ntc_c_01');
    expect(requests.filter((request) => request.includes('/notices'))).toEqual([]);

    await userEvent.click(screen.getByRole('link', { name: 'Back to home' }));
    expect(
      await screen.findByRole('heading', { name: 'Hospital management system' }),
    ).toBeInTheDocument();
  });

  it('does not ask the server about a kind of record no feature knows, or a malformed id', async () => {
    signIn(USER_IDS.admin);
    const requests = watchRequests();

    for (const entry of [
      '/open/patient/pat_1',
      '/open/NOTICE/ntc_h_01',
      `/open/notice/${encodeURIComponent('../../session')}`,
      `/open/notice/${'x'.repeat(200)}`,
    ]) {
      const app = renderApp({ entry });
      expect(await screen.findByRole('heading', UNAVAILABLE), entry).toBeInTheDocument();
      app.unmount();
    }

    expect(requests.filter((request) => request.includes('open-link'))).toEqual([]);
  });

  it('never shows what the server said', async () => {
    signIn(USER_IDS.admin);
    server.use(
      http.post(OPEN_URL, () =>
        HttpResponse.json(
          { error: { code: 'link_unavailable', message: 'notice belongs to Riverside Clinic' } },
          { status: 403 },
        ),
      ),
    );

    renderApp({ entry: HOSPITAL_NOTICE });

    await screen.findByRole('heading', UNAVAILABLE);
    expect(screen.queryByText(/Riverside/)).not.toBeInTheDocument();
  });

  it('treats any other refusal the same way', async () => {
    signIn(USER_IDS.admin);
    server.use(http.post(OPEN_URL, () => new HttpResponse(null, { status: 404 })));

    renderApp({ entry: HOSPITAL_NOTICE });

    expect(await screen.findByRole('heading', UNAVAILABLE)).toBeInTheDocument();
  });

  it('tells a connection problem apart, and can try again', async () => {
    signIn(USER_IDS.admin);
    server.use(http.post(OPEN_URL, () => HttpResponse.error(), { once: true }));

    renderApp({ entry: HOSPITAL_NOTICE });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not open the link');
    expect(alert).toHaveTextContent('Cannot reach the server.');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Staff notices' })).toBeInTheDocument(),
    );
  });
});
