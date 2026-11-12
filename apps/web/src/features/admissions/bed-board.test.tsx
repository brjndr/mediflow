import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { changeMockBed, mockBedStreams } from '@/mocks/handlers/admissions';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Bed board', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const LIVE = 'Live: changes show within seconds.';

const grid = () => screen.getByRole('table', { name: 'Beds' });
const rowOf = (bed: string) =>
  within(grid())
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === bed) as HTMLElement;
const statusLine = () =>
  screen.getByText(
    (_, element) =>
      element?.getAttribute('role') === 'status' &&
      element.tagName === 'P' &&
      element.hasAttribute('tabindex'),
  );

const openBoard = async () => {
  const app = renderApp({ entry: '/beds' });
  await screen.findByRole('heading', HEADING);
  await screen.findByText(LIVE);
  await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBeGreaterThan(1));
  return app;
};

describe('the bed board', () => {
  it('lists the beds by ward with their status, and who is in an occupied one', async () => {
    await openBoard();
    const occupied = rowOf('GW-A-01');
    expect(within(occupied).getByText('Occupied')).toBeInTheDocument();
    expect(within(occupied).getAllByRole('cell')[5]?.textContent).toMatch(/[A-Za-z]+ [A-Za-z]+/);
    // The MRN is masked, and an empty bed names nobody.
    expect(occupied.textContent).not.toMatch(/MRN-PTH-\d{5}/);
    expect(within(rowOf('GW-A-03')).getByText('Being cleaned')).toBeInTheDocument();
    expect(within(rowOf('GW-A-04')).getByText('Blocked: Repair')).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 20_000);

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Bed board' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('filters by status and by ward', async () => {
    await openBoard();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Blocked');
    await waitFor(() => expect(within(grid()).getAllByRole('row')).toHaveLength(2));
    expect(rowOf('GW-A-04')).toBeDefined();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Occupied');
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Ward' }),
      'Intensive care unit',
    );
    await waitFor(() => expect(within(grid()).getAllByRole('row')).toHaveLength(2));
    expect(rowOf('ICU-01')).toBeDefined();
  });

  it('searches wards on the server when the hospital has more than one page of them', async () => {
    const asked: string[] = [];
    server.use(
      http.get('*/api/wards', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        asked.push(q);
        const items =
          q === ''
            ? [{ id: 'ward_h_gw-a', name: 'General ward A' }]
            : [{ id: 'ward_h_icu', name: 'Intensive care unit' }];
        return HttpResponse.json({ items, nextCursor: q === '' ? 'more' : null });
      }),
    );
    await openBoard();
    expect(screen.queryByRole('combobox', { name: 'Ward' })).not.toHaveAttribute(
      'aria-haspopup',
      'false',
    );
    await userEvent.type(await screen.findByRole('combobox', { name: 'Ward' }), 'intensive');
    await userEvent.click(await screen.findByRole('option', { name: 'Intensive care unit' }));
    expect(await screen.findByText('Ward: Intensive care unit')).toBeInTheDocument();
    expect(asked).toContain('intensive');
    await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBeGreaterThan(1));
    await userEvent.click(screen.getByRole('button', { name: 'Every ward' }));
    expect(screen.queryByText('Ward: Intensive care unit')).not.toBeInTheDocument();
  });

  it('marks a bed being cleaned and ready again, and says so', async () => {
    await openBoard();
    await userEvent.click(
      within(rowOf('GW-A-05')).getByRole('button', { name: /Mark being cleaned/ }),
    );
    await waitFor(() =>
      expect(within(rowOf('GW-A-05')).getByText('Being cleaned')).toBeInTheDocument(),
    );
    expect(statusLine()).toHaveTextContent('Bed GW-A-05 is marked as being cleaned.');

    await userEvent.click(within(rowOf('GW-A-05')).getByRole('button', { name: /Mark ready/ }));
    await waitFor(() =>
      expect(within(rowOf('GW-A-05')).getByText('Available')).toBeInTheDocument(),
    );
    expect(statusLine()).toHaveTextContent('Bed GW-A-05 is ready.');
  });

  it('offers only the moves a status allows', async () => {
    await openBoard();
    const occupied = within(rowOf('GW-A-01'));
    for (const name of [/Mark being cleaned/, /Mark ready/, /Block/, /Put back in use/]) {
      expect(occupied.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
    expect(
      within(rowOf('GW-A-04')).getByRole('button', { name: /Put back in use/ }),
    ).not.toHaveAttribute('aria-disabled');
  });

  it('blocks a bed with a reason from the list and puts it back in use', async () => {
    await openBoard();
    await userEvent.click(within(rowOf('GW-A-06')).getByRole('button', { name: /Block/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Block bed' }));
    expect(await screen.findByText('Choose a reason.')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Reason/ }), 'Maintenance');
    await userEvent.click(screen.getByRole('button', { name: 'Block bed' }));
    await waitFor(() =>
      expect(within(rowOf('GW-A-06')).getByText('Blocked: Maintenance')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('heading', { name: 'Block bed GW-A-06' })).not.toBeInTheDocument();

    await userEvent.click(
      within(rowOf('GW-A-06')).getByRole('button', { name: /Put back in use/ }),
    );
    await waitFor(() =>
      expect(within(rowOf('GW-A-06')).getByText('Available')).toBeInTheDocument(),
    );
  });

  it('shows a change made at another desk within seconds, without a reload', async () => {
    await openBoard();
    expect(within(rowOf('GW-A-07')).getByText('Available')).toBeInTheDocument();
    changeMockBed(TENANT_IDS.hospital, 'ward_h_gw-a_b7', 'ward_h_gw-a', 'cleaning');
    await waitFor(() =>
      expect(within(rowOf('GW-A-07')).getByText('Being cleaned')).toBeInTheDocument(),
    );
  });

  it('says a bed changed by someone else first, and reads the board again', async () => {
    await openBoard();
    // The board still shows the bed available when someone else has marked it already.
    server.use(
      http.post('*/api/beds/:bedId/housekeeping', () =>
        HttpResponse.json(
          { error: { code: 'conflict', message: 'It has changed', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(
      within(rowOf('GW-A-08')).getByRole('button', { name: /Mark being cleaned/ }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this bed first',
    );
  });

  it('says when live updates are not available, and still shows the beds', async () => {
    server.use(http.get('*/api/beds/events', () => new HttpResponse(null, { status: 403 })));
    renderApp({ entry: '/beds' });
    expect(
      await screen.findByText(
        'Live updates are not available. The board refreshes every 15 seconds.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBeGreaterThan(1));
  });
});

describe('access to the bed board', () => {
  it('is closed without admission:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'admission:read');
    renderApp({ entry: '/beds' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bed board' })).not.toBeInTheDocument();
  });

  it('shows no cleaning actions without bed:update, and no blocking without ward:manage', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bed:update');
    revokePermission(TENANT_IDS.hospital, 'admin', 'ward:manage');
    await openBoard();
    expect(screen.queryByRole('button', { name: /Mark being cleaned/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Block/ })).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'admissions', false);
    renderApp({ entry: '/beds' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bed board' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('has no bed board at the clinic, and closes the hospital’s stream on the switch', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'admission:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openBoard();
    expect(mockBedStreams(TENANT_IDS.hospital)).toBe(1);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(screen.queryByRole('link', { name: 'Bed board' })).not.toBeInTheDocument();
    expect(mockBedStreams(TENANT_IDS.clinic)).toBe(0);
  });
});
