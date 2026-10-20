import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grantPermission,
  mockRoleGrants,
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { addPastMockEncounters } from '@/mocks/handlers/clinical';
import { mockDoctorOfUser } from '@/mocks/handlers/doctors';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
const TAB = { name: 'Clinical timeline' };

const openTab = async (id = 'pth_00001') => {
  const app = renderApp({ entry: `/patients/${id}?tab=timeline` });
  await screen.findByRole('tab', { ...TAB, selected: true });
  return app;
};

const visitRows = async () => {
  const table = await screen.findByRole('table', { name: 'Visits' });
  return within(table).getAllByRole('row').slice(1);
};

afterEach(() => server.events.removeAllListeners());

/** The query of every request for a list of encounters. */
function watchLists(): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.endsWith('/api/encounters')) {
      seen.push(url.searchParams);
    }
  });
  return seen;
}

describe('the clinical timeline tab', () => {
  it('lists the patient’s visits newest first, each opening its consultation', async () => {
    const lists = watchLists();
    addPastMockEncounters(HOSPITAL, 'pth_00001', 'doc_h_02', 2);
    await openTab();
    expect(await screen.findByText('3 visits')).toBeInTheDocument();
    const rows = await visitRows();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Open')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Outpatient')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Closed')).toBeInTheDocument();
    // The patient's own only, and the id is the only thing about them in the address.
    expect(lists.at(-1)?.get('patientId')).toBe('pth_00001');
    await expectNoAxeViolations();

    await userEvent.click(within(rows[0]!).getByRole('link'));
    expect(
      await screen.findByRole('heading', { name: 'Consultation', level: 1 }),
    ).toBeInTheDocument();
  });

  it('filters by type and status on the server', async () => {
    const lists = watchLists();
    addPastMockEncounters(HOSPITAL, 'pth_00001', 'doc_h_02', 2);
    await openTab();
    await screen.findByText('3 visits');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'closed');
    expect(await screen.findByText('2 visits')).toBeInTheDocument();
    expect(lists.at(-1)?.get('status')).toBe('closed');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Type of visit' }), 'ipd');
    expect(await screen.findByText('No visits to show.')).toBeInTheDocument();
    expect(lists.at(-1)?.get('type')).toBe('ipd');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Type of visit' }), 'opd');
    expect(await screen.findByText('2 visits')).toBeInTheDocument();
  });

  it('loads a long history a page at a time', async () => {
    addPastMockEncounters(HOSPITAL, 'pth_00001', 'doc_h_02', 30);
    await openTab();
    expect(await screen.findByText('31 visits')).toBeInTheDocument();
    expect(await visitRows()).toHaveLength(25);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(async () => expect(await visitRows()).toHaveLength(31));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says so for a patient with no visits', async () => {
    await openTab('pth_00102');
    expect(await screen.findByText('No visits to show.')).toBeInTheDocument();
  });

  it('says when the visits could not be read, and reads them again on retry', async () => {
    server.use(
      http.get('*/api/encounters', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'Down' } }, { status: 500 }),
      ),
    );
    await openTab();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    server.resetHandlers();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1 visit')).toBeInTheDocument();
  });

  it('shows only the visits within the caller’s scope, as the server leaves them out', async () => {
    // The mock's doctor has no doctor profile at the hospital, so attends none of its visits.
    signIn(USER_IDS.doctor, HOSPITAL);
    expect(mockDoctorOfUser(HOSPITAL, USER_IDS.doctor)).toBeUndefined();
    setRolePermissions(HOSPITAL, 'doctor', [
      ...mockRoleGrants(HOSPITAL, 'doctor').filter((each) => each.permission !== 'encounter:read'),
      { permission: 'encounter:read', scope: 'own' },
    ]);
    await openTab();
    expect(await screen.findByText('No visits to show.')).toBeInTheDocument();
    // None is said once, by the grid.
    expect(screen.queryByText('0 visits')).not.toBeInTheDocument();
  });

  it('is not offered without encounter:read, and reads nothing', async () => {
    const lists = watchLists();
    revokePermission(HOSPITAL, 'admin', 'encounter:read');
    renderApp({ entry: '/patients/pth_00001' });
    // The other contributed tab shows the slot has rendered.
    await screen.findByRole('tab', { name: 'Vitals and allergies' });
    expect(screen.queryByRole('tab', TAB)).not.toBeInTheDocument();
    expect(lists).toHaveLength(0);
  });

  it('is not offered with the switch off', async () => {
    const lists = watchLists();
    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tab', { name: 'Vitals and allergies' });
    expect(screen.queryByRole('tab', TAB)).not.toBeInTheDocument();
    expect(lists).toHaveLength(0);
  });

  it('works for a custom role given the permission', async () => {
    signIn(USER_IDS.billingClerk, TENANT_IDS.clinic);
    const first = renderApp({ entry: '/patients/ptc_00001' });
    await screen.findByRole('tab', { name: 'Details' });
    expect(screen.queryByRole('tab', TAB)).not.toBeInTheDocument();
    first.unmount();

    grantPermission(TENANT_IDS.clinic, 'billing_clerk', 'encounter:read');
    await openTab('ptc_00001');
    expect(await screen.findByText('1 visit')).toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('shows the clinic its own patient’s visits and never the hospital’s', async () => {
    const lists = watchLists();
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    await openTab('ptc_00001');
    expect(await screen.findByText('1 visit')).toBeInTheDocument();
    expect(await visitRows()).toHaveLength(1);
    expect(lists.at(-1)?.get('patientId')).toBe('ptc_00001');
  });

  it('leaves none of the first hospital’s visits behind on a switch', async () => {
    signIn(USER_IDS.doctor, HOSPITAL);
    const { queryClient } = await openTab();
    expect(await screen.findByText('1 visit')).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await waitFor(() =>
      expect(queryClient.getQueryCache().findAll({ queryKey: ['tenant', HOSPITAL] })).toHaveLength(
        0,
      ),
    );
    await waitFor(() => expect(screen.queryByText('1 visit')).not.toBeInTheDocument());
    expect(screen.queryByRole('table', { name: 'Visits' })).not.toBeInTheDocument();
  });
});
