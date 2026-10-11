import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { renderApp } from '@/test/render';
import { patientKeys } from './hooks/use-patients';

const HEADING = { name: 'Patients' };
const NO_ACCESS = { name: 'You do not have access to this page' };

const grid = () => screen.getByRole('table', { name: 'Patients' });
const dataRows = () => within(grid()).getAllByRole('row').slice(1);
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });
const navLink = () => screen.queryByRole('link', { name: 'Patients' });

/** Query strings seen on patient requests: patient data must never travel in one. */
const queryStrings: string[] = [];

/** Records the body of each patient search request, then lets the mock backend answer. */
function watchPatientRequests() {
  const requests: URLSearchParams[] = [];
  queryStrings.length = 0;
  server.use(
    http.post('*/api/patients/search', async ({ request }) => {
      queryStrings.push(new URL(request.url).search);
      const body = (await request.clone().json()) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) params.set(key, String(value));
      }
      requests.push(params);
      return undefined;
    }),
  );
  return requests;
}

describe('patient list', () => {
  it('is reached from the nav and loads one server page at a time', async () => {
    const requests = watchPatientRequests();
    renderApp();
    await home();

    await userEvent.click(screen.getByRole('link', { name: 'Patients' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(dataRows()).toHaveLength(25));
    expect(await screen.findByText('12000 patients')).toBeInTheDocument();
    expect(requests.map((params) => params.get('limit'))).toEqual(['25']);
    expect(requests[0]?.has('cursor')).toBe(false);
  });

  it('shows the date of birth in the hospital format', async () => {
    renderApp({ entry: '/patients' });
    await waitFor(() => expect(dataRows()).toHaveLength(25));
    // The first synthetic patient was born on 1950-01-01.
    expect(within(dataRows()[0]!).getByText('1 Jan 1950')).toBeInTheDocument();
    expect(grid().textContent).not.toContain('1950-01-01');
  });

  it('masks phone and MRN in the list', async () => {
    renderApp({ entry: '/patients' });
    await waitFor(() => expect(dataRows()).toHaveLength(25));
    const text = grid().textContent ?? '';
    expect(text).not.toContain('MRN-PTH-00001');
    expect(text).not.toContain('+91 98000 10000');
  });

  it('searches on the server, debounced, and keeps the text out of the URL', async () => {
    const requests = watchPatientRequests();
    const { router } = renderApp({ entry: '/patients' });
    await waitFor(() => expect(dataRows()).toHaveLength(25));

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search patients' }),
      'MRN-PTH-00042',
    );

    await waitFor(() => expect(dataRows()).toHaveLength(1));
    // Typing fast makes one request, not one per key.
    const searches = requests.filter((params) => params.has('q'));
    expect(searches).toHaveLength(1);
    expect(searches[0]?.get('q')).toBe('MRN-PTH-00042');
    // The term is in the request body: the requests have no query string at all.
    expect(queryStrings.length).toBeGreaterThan(0);
    expect(queryStrings.every((search) => search === '')).toBe(true);
    expect(router.state.location.search).toBe('');
    expect(router.state.location.pathname).toBe('/patients');
  });

  it('shows an empty state when nothing matches', async () => {
    renderApp({ entry: '/patients' });
    await waitFor(() => expect(dataRows()).toHaveLength(25));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search patients' }), 'zzzzqq');
    expect(await screen.findByText('No patients match your search.')).toBeInTheDocument();

    // What was searched for, and the two things to do next.
    expect(await screen.findByText('No patient matches “zzzzqq”.')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: 'Register a patient' }).length,
    ).toBeGreaterThanOrEqual(2);
    await userEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(screen.getByRole('searchbox', { name: 'Search patients' })).toHaveValue('');
    expect(await screen.findByText('12000 patients')).toBeInTheDocument();
    expect(screen.queryByText(/^No patient matches/)).not.toBeInTheDocument();
  });

  it('asks the server to sort, and pages by cursor', async () => {
    const requests = watchPatientRequests();
    renderApp({ entry: '/patients' });
    await waitFor(() => expect(dataRows()).toHaveLength(25));

    await userEvent.click(screen.getByRole('button', { name: /MRN/ }));
    await waitFor(() => expect(requests.some((params) => params.get('sort') === 'mrn')).toBe(true));

    await userEvent.click(await screen.findByRole('button', { name: /load more/i }));
    await waitFor(() => expect(requests.some((params) => params.has('cursor'))).toBe(true));
    await waitFor(() => expect(dataRows()).toHaveLength(50));
  });

  it('lets the user choose a page size of 25 to 100', async () => {
    const requests = watchPatientRequests();
    renderApp({ entry: '/patients' });
    await waitFor(() => expect(dataRows()).toHaveLength(25));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Rows per page' }), '100');
    await waitFor(() => expect(requests.at(-1)?.get('limit')).toBe('100'));
  });
});

describe('permission absent', () => {
  it('hides the nav item and blocks the page without patient:read', async () => {
    const requests = watchPatientRequests();
    revokePermission(TENANT_IDS.hospital, 'doctor', 'patient:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/patients' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(navLink()).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('feature flag off', () => {
  it('hides the page and the nav, and makes no request', async () => {
    const requests = watchPatientRequests();
    setTenantFeature(TENANT_IDS.clinic, 'patients', false);
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/patients' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(navLink()).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s patients in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient } = renderApp({ entry: '/patients' });
    await waitFor(() => expect(dataRows()).toHaveLength(25));
    expect(
      queryClient.getQueryCache().findAll({ queryKey: patientKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await home();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: patientKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await userEvent.click(screen.getByRole('link', { name: 'Patients' }));
    expect(await screen.findByText('40 patients')).toBeInTheDocument();
    expect(grid().textContent).not.toContain('PTH');
  });
});
