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
import { mockStaffOf } from '@/mocks/handlers/staff';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Ambulances', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const tripGrid = () => screen.getByRole('table', { name: 'Ambulance trips' });
const fleetGrid = () => screen.getByRole('table', { name: 'Ambulances' });
const rowOf = (grid: HTMLElement, first: string) =>
  within(grid)
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === first) as HTMLElement;

const open = async () => {
  renderApp({ entry: '/ambulances' });
  await screen.findByRole('heading', HEADING);
  await waitFor(() => {
    expect(rowOf(tripGrid(), 'Main Road junction')).toBeDefined();
    expect(rowOf(fleetGrid(), 'KA01AB1234')).toBeDefined();
  });
};

describe('ambulances', () => {
  it('lists the trips and the fleet', async () => {
    await open();
    const trip = rowOf(tripGrid(), 'Main Road junction');
    expect(within(trip).getByText('Emergency entrance')).toBeInTheDocument();
    expect(within(trip).getByText('Requested')).toBeInTheDocument();
    expect(within(rowOf(fleetGrid(), 'KA01AB1234')).getByText('Available')).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 20_000);

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Ambulances' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('requests a trip, with the place checked first', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Request a trip' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Request trip' }));
    expect(await screen.findAllByText(/required/i)).not.toHaveLength(0);

    await userEvent.type(screen.getByRole('textbox', { name: /Pick-up place/ }), 'Lake road');
    await userEvent.type(screen.getByRole('textbox', { name: /Destination/ }), 'Casualty');
    await userEvent.click(screen.getByRole('button', { name: 'Request trip' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Trip requested.'));
    await waitFor(() => expect(rowOf(tripGrid(), 'Lake road')).toBeDefined());
  }, 20_000);

  it('names the visit and the service a trip is charged as, and shows the charge', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Request a trip' }));
    await userEvent.type(await screen.findByRole('textbox', { name: /Pick-up place/ }), 'Ward 3');
    await userEvent.type(screen.getByRole('textbox', { name: /Destination/ }), 'Scan centre');
    await userEvent.type(screen.getByRole('combobox', { name: /^Patient/ }), 'Asha');
    await userEvent.click((await screen.findAllByRole('option'))[0] as HTMLElement);
    const visit = await screen.findByRole('combobox', { name: /Charge to visit/ });
    await waitFor(() => expect(within(visit).getAllByRole('option')).toHaveLength(2));
    await userEvent.selectOptions(visit, within(visit).getAllByRole('option')[1] as HTMLElement);
    await userEvent.type(screen.getByRole('combobox', { name: /Service to charge/ }), 'Chest');
    await userEvent.click(await screen.findByRole('option', { name: /Chest X-ray/ }));
    expect(screen.getByText(/at the price list's price/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Request trip' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Trip requested.'));
    const row = await waitFor(() => rowOf(tripGrid(), 'Ward 3'));
    expect(within(row).getByText('Chest X-ray, billed when completed')).toBeInTheDocument();
    expect(
      within(rowOf(tripGrid(), 'Main Road junction')).getByText('Not charged'),
    ).toBeInTheDocument();
  }, 30_000);

  it('dispatches a trip, runs it to the end and frees the ambulance', async () => {
    await open();
    await userEvent.click(
      within(rowOf(tripGrid(), 'Main Road junction')).getByRole('button', { name: /Dispatch/ }),
    );
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: /Ambulance/ }),
      'KA01AB1234 (Advanced life support)',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Trip dispatched with KA01AB1234.'),
    );
    await waitFor(() =>
      expect(within(rowOf(fleetGrid(), 'KA01AB1234')).getByText('On a trip')).toBeInTheDocument(),
    );

    const trip = () => rowOf(tripGrid(), 'Main Road junction');
    await userEvent.click(within(trip()).getByRole('button', { name: /Patient picked up/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Patient picked up.'));
    await waitFor(() =>
      expect(within(trip()).getByRole('button', { name: /Complete trip/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await userEvent.click(within(trip()).getByRole('button', { name: /Complete trip/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Trip completed'));
    await waitFor(() =>
      expect(within(rowOf(fleetGrid(), 'KA01AB1234')).getByText('Available')).toBeInTheDocument(),
    );
  }, 30_000);

  it('names a driver and a paramedic when dispatching, and shows the crew on the trip', async () => {
    await open();
    const [driver, medic] = mockStaffOf(TENANT_IDS.hospital).slice(2, 4);
    await userEvent.click(
      within(rowOf(tripGrid(), 'Main Road junction')).getByRole('button', { name: /Dispatch/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      await within(dialog).findByRole('combobox', { name: /Ambulance/ }),
      'KA01AB1234 (Advanced life support)',
    );
    const add = async (name: string) => {
      await userEvent.type(
        within(dialog).getByRole('combobox', { name: /Add a crew member/ }),
        name,
      );
      await userEvent.click(await within(dialog).findByRole('option', { name }));
    };
    await add(driver?.name ?? '');
    // One driver only: the duty moves on to paramedic and driver is no longer offered.
    expect(within(dialog).queryByRole('option', { name: 'Driver' })).not.toBeInTheDocument();
    await add(medic?.name ?? '');
    expect(within(dialog).getByRole('list', { name: 'Crew on this trip' })).toHaveTextContent(
      `${driver?.name} (Driver)`,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dispatch' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Trip dispatched with KA01AB1234.'),
    );
    await waitFor(() =>
      expect(rowOf(tripGrid(), 'Main Road junction')).toHaveTextContent(
        `${driver?.name} (Driver), ${medic?.name} (Paramedic)`,
      ),
    );
  }, 30_000);

  it('takes an ambulance out of service and back', async () => {
    await open();
    await userEvent.click(
      within(rowOf(fleetGrid(), 'KA01CD5678')).getByRole('button', { name: /Out of service/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('KA01CD5678 is out of service.'),
    );
    await waitFor(() =>
      expect(
        within(rowOf(fleetGrid(), 'KA01CD5678')).getByText('Out of service'),
      ).toBeInTheDocument(),
    );
  });

  it('adds an ambulance and refuses a registration that exists', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add an ambulance' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: /Registration number/ }),
      'ka01ab1234',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add ambulance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');

    await userEvent.clear(screen.getByRole('textbox', { name: /Registration number/ }));
    await userEvent.type(
      screen.getByRole('textbox', { name: /Registration number/ }),
      'KA09ZZ0001',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add ambulance' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Ambulance KA09ZZ0001 added.'),
    );
  }, 20_000);

  it('says a trip was changed by someone else first', async () => {
    await open();
    server.use(
      http.post('*/api/ambulance-trips/:tripId/move', () =>
        HttpResponse.json(
          { error: { code: 'conflict', message: 'It has changed', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(
      within(rowOf(tripGrid(), 'Main Road junction')).getByRole('button', { name: /Cancel trip/ }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this first');
  });
});

describe('access to ambulances', () => {
  it('is closed without ambulance:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'ambulance:read');
    renderApp({ entry: '/ambulances' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ambulances' })).not.toBeInTheDocument();
  });

  it('offers no request, dispatch or fleet change without the permissions', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'ambulance:dispatch');
    revokePermission(TENANT_IDS.hospital, 'admin', 'ambulance:manage');
    await open();
    expect(screen.queryByRole('button', { name: 'Request a trip' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add an ambulance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dispatch/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Out of service/ })).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'ambulance', false);
    renderApp({ entry: '/ambulances' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ambulances' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('has no ambulances at the clinic', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'ambulance:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await open();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(screen.queryByRole('link', { name: 'Ambulances' })).not.toBeInTheDocument();
  });
});
