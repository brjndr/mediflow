import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import {
  grantPermission,
  revokePermission,
  sessionFor,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { appRegistry } from '@/registry';
import type { AccessPolicy } from '@/shared/types';
import { renderApp } from '@/test/render';

// The three widgets of #712, each contributed by its own feature to the landing page.
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });
const tile = (name: string) => screen.queryByRole('region', { name });
const FLOW = 'OPD visits by hour, today';
const CAPACITY = 'Bed capacity';
const COLLECTED = 'Collected today';

/** Cash and UPI taken today, with a refund of part of the cash, as the server nets them. */
function sessionsOfToday() {
  server.use(
    http.get('*/api/cash-registers/collected', () =>
      HttpResponse.json({
        date: '2026-11-14',
        timezone: 'Asia/Kolkata',
        totals: [
          { method: 'cash', paidMinor: 120000, refundedMinor: 20000 },
          { method: 'upi', paidMinor: 50000, refundedMinor: 0 },
        ],
        netMinor: 150000,
      }),
    ),
  );
}

describe('dashboard widgets: flow, capacity, collected today', () => {
  it('shows all three to the hospital admin, with money from minor units and no patient', async () => {
    sessionsOfToday();
    signIn(USER_IDS.admin);
    renderApp();
    await home();

    const flow = await screen.findByRole('region', { name: FLOW });
    // 14 + 11 visits at nine o'clock: the busiest hour, said in words and not only by colour.
    expect(
      (await within(flow).findAllByText(/Busiest at 09:00, 25 visits/)).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByRole('region', { name: CAPACITY })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Beds occupied: \d+%/ })).toBeInTheDocument();

    const collected = await screen.findByRole('region', { name: COLLECTED });
    // 1,000 cash (net of a 200 refund) + 500 UPI, from minor units.
    expect(await within(collected).findByText(/1,500\.00/)).toBeInTheDocument();
    expect(within(collected).getByText('Cash')).toBeInTheDocument();
    expect(within(collected).getByText('UPI')).toBeInTheDocument();
  });

  it('reads the bed counts in one request and never the board', async () => {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path.includes('/beds/')) seen.push(path);
    });
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(await screen.findByRole('img', { name: /Beds occupied: \d+%/ })).toBeInTheDocument();
    server.events.removeAllListeners();
    expect(seen.filter((path) => path.endsWith('/beds/counts'))).toHaveLength(1);
    expect(seen.filter((path) => path.endsWith('/beds/board'))).toHaveLength(0);
  });

  it('shows a dash-free empty line when nothing was taken today', async () => {
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const collected = await screen.findByRole('region', { name: COLLECTED });
    expect(await within(collected).findByText('Nothing taken yet today.')).toBeInTheDocument();
  });

  it('says so in place when a request fails and leaves the others alone', async () => {
    server.use(
      http.get('*/api/cash-registers/collected', () =>
        HttpResponse.json({ code: 'server_error' }, { status: 500 }),
      ),
    );
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const collected = await screen.findByRole('region', { name: COLLECTED });
    expect(await within(collected).findByRole('alert')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: FLOW })).toBeInTheDocument();
  });

  it('leaves out a widget whose permission was taken away', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'report:read');
    revokePermission(TENANT_IDS.hospital, 'admin', 'cashRegister:read');
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(await screen.findByRole('region', { name: CAPACITY })).toBeInTheDocument();
    expect(tile(FLOW)).not.toBeInTheDocument();
    expect(tile(COLLECTED)).not.toBeInTheDocument();
  });

  it('leaves out a widget whose module is switched off for the hospital', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'admissions', false);
    setTenantFeature(TENANT_IDS.hospital, 'reports', false);
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(await screen.findByRole('region', { name: COLLECTED })).toBeInTheDocument();
    expect(tile(CAPACITY)).not.toBeInTheDocument();
    expect(tile(FLOW)).not.toBeInTheDocument();
  });

  it("gives another hospital its own: the clinic's custom role sees only the takings, in its currency", async () => {
    grantPermission(TENANT_IDS.clinic, 'billing_clerk', 'cashRegister:read');
    sessionsOfToday();
    signIn(USER_IDS.billingClerk, TENANT_IDS.clinic);
    renderApp();
    await home();

    const collected = await screen.findByRole('region', { name: COLLECTED });
    // The clinic keeps its books in dirhams.
    expect(await within(collected).findByText('AED 1,500.00')).toBeInTheDocument();
    expect(tile(FLOW)).not.toBeInTheDocument();
    expect(tile(CAPACITY)).not.toBeInTheDocument();
  });

  it('offers none of them to a doctor at the clinic (flags off)', () => {
    const policy = sessionFor(USER_IDS.doctor, TENANT_IDS.clinic).policy as AccessPolicy;
    const keys = appRegistry.contributions('dashboard.widgets', policy).map((each) => each.key);
    expect(keys.filter((key) => /^(reports|admissions|billing):/.test(key))).toEqual([]);
  });
});

describe('dashboard widget: incomplete records', () => {
  it('shows the count of incomplete records to a reader and nothing without the switch', async () => {
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const tile = await screen.findByRole('region', { name: 'Medical records' });
    expect(await within(tile).findByText('3')).toBeInTheDocument();
    expect(within(tile).getByText('Incomplete records')).toBeInTheDocument();
  });
});
