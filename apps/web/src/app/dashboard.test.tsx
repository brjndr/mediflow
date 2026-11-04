import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { expectNoAxeViolations } from '@/test/axe';
import { HomePage } from './HomePage';

const widget = (name: string) => screen.findByRole('region', { name });

describe('dashboard', () => {
  it('shows each panel the role may see, with counts and a link to the full screen', async () => {
    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    const { container } = renderWithProviders(<HomePage />);

    const queue = await widget('OPD queue');
    expect(await within(queue).findByText('Waiting now')).toBeInTheDocument();
    expect(within(queue).getByRole('link', { name: 'Open the queue' })).toHaveAttribute(
      'href',
      '/queue',
    );
    expect(await widget('Laboratory')).toBeInTheDocument();
    expect(await widget('Stock alerts')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows a role only the panels its permissions allow', async () => {
    // The store keeper reads stock, not the queue or the laboratory.
    signIn(USER_IDS.storeKeeper, TENANT_IDS.hospital);
    renderWithProviders(<HomePage />);

    expect(await widget('Stock alerts')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'OPD queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Laboratory' })).not.toBeInTheDocument();
  });

  it('removes a panel when its feature is switched off, and asks the server for nothing', async () => {
    const requests: string[] = [];
    server.use(
      http.get('*/api/inventory/stock/alerts', () => {
        requests.push('alerts');
        return undefined;
      }),
    );
    setTenantFeature(TENANT_IDS.hospital, 'inventory', false);
    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    renderWithProviders(<HomePage />);

    expect(await widget('OPD queue')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Stock alerts' })).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('keeps the other panels when one fails to load', async () => {
    server.use(
      http.get('*/api/inventory/stock/alerts', () => new HttpResponse(null, { status: 500 })),
    );
    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    renderWithProviders(<HomePage />);

    const stock = await widget('Stock alerts');
    expect(await within(stock).findByRole('alert')).toBeInTheDocument();
    expect(await widget('OPD queue')).toBeInTheDocument();
    expect(await widget('Laboratory')).toBeInTheDocument();
  });

  it('says so when nothing is contributed for the role', async () => {
    // The receptionist reads no queue, lab or stock data at this hospital.
    signIn(USER_IDS.billingClerk, TENANT_IDS.hospital);
    renderWithProviders(<HomePage />);
    expect(await screen.findByText(/nothing to show here/i)).toBeInTheDocument();
  });

  it('shows another hospital its own panels, never the first one’s', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderWithProviders(<HomePage />);
    // The clinic has the laboratory and inventory flags off.
    expect(await screen.findByText('API status:')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Laboratory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Stock alerts' })).not.toBeInTheDocument();
  });
});
