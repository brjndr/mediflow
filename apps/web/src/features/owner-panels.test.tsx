import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { renderApp } from '@/test/render';

// The owner's panels of #690: visits today and unpaid invoices, from the reports API.
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });
const tile = (name: string) => screen.queryByRole('region', { name });
const VISITS = 'OPD visits today';
const UNPAID = 'Unpaid invoices';

describe('owner dashboard panels', () => {
  it('shows visits and unpaid invoices to the admin, counts and amounts only', async () => {
    server.use(
      http.post('*/api/reports/outstanding', () =>
        HttpResponse.json({
          kind: 'outstanding',
          from: null,
          to: null,
          currency: 'INR',
          generatedAt: new Date().toISOString(),
          columns: [
            { key: 'ageBucket', type: 'text' },
            { key: 'invoices', type: 'integer' },
            { key: 'dueMinor', type: 'money' },
          ],
          rows: [
            ['days_0_7', 2, 150000],
            ['days_8_30', 1, 50000],
            ['over_30', 0, 0],
          ],
          totals: [null, 3, 200000],
        }),
      ),
    );
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const visits = await screen.findByRole('region', { name: VISITS });
    expect(await within(visits).findByText('Opened')).toBeInTheDocument();
    expect(within(visits).getByText('Closed')).toBeInTheDocument();
    const unpaid = await screen.findByRole('region', { name: UNPAID });
    expect(await within(unpaid).findByText(/2,000\.00/)).toBeInTheDocument();
    expect(within(unpaid).getByText('3 invoices due')).toBeInTheDocument();
    expect(within(unpaid).getByRole('link', { name: 'Open unpaid invoices' })).toHaveAttribute(
      'href',
      '/billing/invoices?status=issued',
    );
  });

  it('says so in place when the unpaid figure fails and the visits panel carries on', async () => {
    server.use(
      http.post('*/api/reports/outstanding', () =>
        HttpResponse.json({ code: 'server_error' }, { status: 500 }),
      ),
    );
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const unpaid = await screen.findByRole('region', { name: UNPAID });
    expect(await within(unpaid).findByRole('alert')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: VISITS })).toBeInTheDocument();
  });

  it('leaves the unpaid panel out without the billing permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'invoice:read');
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(await screen.findByRole('region', { name: VISITS })).toBeInTheDocument();
    expect(tile(UNPAID)).not.toBeInTheDocument();
  });

  it('leaves both out when the reports module is off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'reports', false);
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(tile(VISITS)).not.toBeInTheDocument();
    expect(tile(UNPAID)).not.toBeInTheDocument();
  });
});
