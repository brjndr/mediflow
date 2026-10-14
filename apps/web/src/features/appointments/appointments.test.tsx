import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockDoctor } from '@/mocks/handlers/doctors';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { appointmentKeys } from './hooks/use-appointments';

const HEADING = { name: 'Appointments', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const grid = () => screen.getByRole('table', { name: 'Appointments' });
/** The body rows of the grid: every row but the header. */
const rows = () => within(grid()).getAllByRole('row').slice(1);
const cellsOf = (column: number) =>
  rows().map((row) => within(row).getAllByRole('cell')[column]?.textContent ?? '');
const setDay = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Every request the list made, as the server saw its address. */
function watchRequests(): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/appointments')) seen.push(url.searchParams);
  });
  return seen;
}

const openList = async () => {
  const app = renderApp({ entry: '/appointments' });
  await screen.findByRole('heading', HEADING);
  // Six doctors with eight appointments each this morning, at the hospital.
  await waitFor(() => expect(statuses()).toContain('48 appointments'));
  return app;
};

describe('the appointment list', () => {
  it('opens on today at the hospital, a page at a time', async () => {
    await openList();
    expect(rows()).toHaveLength(25);

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(48));
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Appointments' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('asks the server for the days, the doctor and the status, and starts again on a change', async () => {
    const seen = watchRequests();
    await openList();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(seen.some((params) => params.has('cursor'))).toBe(true));

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Cancelled');
    await waitFor(() =>
      expect(cellsOf(5).every((text) => text.startsWith('Cancelled'))).toBe(true),
    );
    const last = seen.at(-1);
    expect(last?.get('status')).toBe('cancelled');
    // A new filter is a new first page.
    expect(last?.has('cursor')).toBe(false);
    expect(rows().length).toBeLessThan(48);
  });

  it('narrows to one doctor', async () => {
    await openList();
    const doctor = screen.getByRole('combobox', { name: 'Doctor' });
    // One of the six doctors with appointments this morning.
    await userEvent.selectOptions(doctor, 'doc_h_02');
    const name = (doctor as HTMLSelectElement).selectedOptions[0]?.textContent;

    await waitFor(() => expect(statuses()).toContain('8 appointments'));
    expect(new Set(cellsOf(3))).toEqual(new Set([name]));
  });

  it('covers several days, and refuses a range it cannot ask for without asking', async () => {
    const seen = watchRequests();
    await openList();
    const from = (screen.getByLabelText('From') as HTMLInputElement).value;
    const later = (days: number) => {
      const date = new Date(`${from}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };

    setDay('To', later(1));
    await waitFor(() => expect(statuses()).toContain('96 appointments'));

    const asked = seen.length;
    setDay('To', later(31));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose at most 31 days.');
    setDay('To', later(-1));
    expect(screen.getByRole('alert')).toHaveTextContent('The last day comes before the first.');
    expect(seen).toHaveLength(asked);

    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(statuses()).toContain('48 appointments'));
  });

  it('shows the MRN masked, and opens the patient by id', async () => {
    const { router } = await openList();
    expect(cellsOf(2).every((text) => !/MRN-PTH-\d{5}/.test(text))).toBe(true);

    const [open] = screen.getAllByRole('button', { name: /^Open the patient/ });
    await userEvent.click(open as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/patients\/pth_\d{5}$/));
  });

  it('offers no way to the patient to someone who may not read patients', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:read');
    await openList();
    expect(screen.queryByRole('button', { name: /^Open the patient/ })).not.toBeInTheDocument();
  });

  it('says so when there is nothing, and when the server fails', async () => {
    await openList();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'No-show');
    // Nobody has missed an appointment today yet.
    expect(await screen.findByText('No appointment matches these filters.')).toBeInTheDocument();

    server.use(
      http.get('*/api/appointments', () =>
        HttpResponse.json({ code: 'internal', message: 'down' }, { status: 500 }),
      ),
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Completed');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('a doctor', () => {
  it('sees their own schedule first, and can widen it to every doctor', async () => {
    editMockDoctor('doc_h_01', { userId: USER_IDS.doctor });
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/appointments' });

    await waitFor(() => expect(statuses()).toContain('8 appointments'));
    const doctor = screen.getByRole('combobox', { name: 'Doctor' }) as HTMLSelectElement;
    expect(doctor.selectedOptions[0]?.textContent).toMatch(/\(you\)$/);

    await userEvent.selectOptions(doctor, 'All doctors');
    await waitFor(() => expect(statuses()).toContain('48 appointments'));
  });

  it('who has no profile here sees every doctor’s', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/appointments' });
    await waitFor(() => expect(statuses()).toContain('48 appointments'));
  });
});

describe('access', () => {
  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'appointment:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/appointments' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Appointments' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'appointments', false);
    renderApp({ entry: '/appointments' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Appointments' })).not.toBeInTheDocument();
    await expect(
      api.GET('/appointments', { params: { query: { from: '2026-10-14', to: '2026-10-14' } } }),
    ).rejects.toMatchObject({ code: 'forbidden', serverCode: 'feature_disabled' });
  });

  it('lists without the doctor filter where doctors are off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'doctors', false);
    await openList();
    expect(screen.queryByRole('combobox', { name: 'Doctor' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s appointments in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: appointmentKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(
      queryClient.getQueryCache().findAll({ queryKey: appointmentKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await userEvent.click(await screen.findByRole('link', { name: 'Appointments' }));
    // The sample doctor has a profile at the clinic: their own three this morning, first.
    await waitFor(() => expect(statuses()).toContain('3 appointments'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Doctor' }), 'All doctors');
    // Two doctors with three each, and none of the hospital's.
    await waitFor(() => expect(statuses()).toContain('6 appointments'));
    expect(cellsOf(2).every((text) => !text.includes('PTH'))).toBe(true);
  });
});
