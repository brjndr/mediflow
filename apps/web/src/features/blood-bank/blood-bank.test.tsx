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
import { addMockBloodUnit } from '@/mocks/handlers/blood-bank';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Blood bank', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const grid = () => screen.getByRole('table', { name: 'Blood units' });
const rowOf = (unit: string) =>
  within(grid())
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === unit) as HTMLElement;

const open = async (unit = 'BU-0001') => {
  renderApp({ entry: '/blood-bank' });
  await screen.findByRole('heading', HEADING);
  await waitFor(() => expect(within(grid()).queryAllByRole('cell').length).toBeGreaterThan(0));
  await waitFor(() => expect(rowOf(unit)).toBeDefined());
};

const filterStatus = async (label: string) => {
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), label);
};

describe('blood bank', () => {
  it('lists available units and the stock that can be given now', async () => {
    await open();
    const row = rowOf('BU-0001');
    expect(within(row).getByText('O+')).toBeInTheDocument();
    expect(within(row).getByText('Red cells')).toBeInTheDocument();
    expect(within(row).getByText('Available')).toBeInTheDocument();
    const stock = screen.getByRole('region', { name: 'In stock now' });
    await waitFor(() => expect(within(stock).getByText('1 available')).toBeInTheDocument());
    await expectNoAxeViolations();
  }, 20_000);

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Blood bank' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('clears a unit in testing for stock', async () => {
    await open();
    await filterStatus('In testing');
    await waitFor(() => expect(rowOf('BU-0002')).toBeDefined());
    await userEvent.click(
      within(rowOf('BU-0002')).getByRole('button', { name: /Clear for stock/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
        'Unit BU-0002 is available.',
      ),
    );
  });

  it('offers only the moves a status allows', async () => {
    await open();
    const row = rowOf('BU-0001');
    expect(within(row).getByRole('button', { name: /Clear for stock/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(row).getByRole('button', { name: /Reserve/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('reserves a unit for a patient found by search', async () => {
    await open();
    await userEvent.click(within(rowOf('BU-0001')).getByRole('button', { name: /Reserve/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reserve unit BU-0001' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: /Patient/ }), 'a');
    const option = await within(dialog).findAllByRole('option');
    await userEvent.click(option[0] as HTMLElement);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reserve' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Reserve unit BU-0001' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Unit BU-0001 reserved.');
  });

  it('asks for a patient before reserving', async () => {
    await open();
    await userEvent.click(within(rowOf('BU-0001')).getByRole('button', { name: /Reserve/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reserve unit BU-0001' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reserve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose the patient');
  });

  it('discards a unit only with a reason', async () => {
    await open();
    await userEvent.click(within(rowOf('BU-0001')).getByRole('button', { name: /Discard/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard unit BU-0001' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard unit' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Bag leaked');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard unit' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Unit BU-0001 discarded.'),
    );
  });

  it('registers a collected unit', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Register a unit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register a collected unit' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Unit number/ }), 'BU-0100');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Volume/ }), '350');
    await userEvent.type(within(dialog).getByLabelText(/Collected/), '2026-11-07T08:00');
    await userEvent.type(within(dialog).getByLabelText(/Expires/), '2026-12-12T08:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register unit' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
        'Unit BU-0100 registered.',
      ),
    );
  });

  it('shows a unit with its history', async () => {
    await open();
    await userEvent.click(within(rowOf('BU-0001')).getByRole('button', { name: /History/ }));
    const dialog = await screen.findByRole('dialog', { name: 'History of unit BU-0001' });
    expect(await within(dialog).findByText('Registered as Collected')).toBeInTheDocument();
    expect(within(dialog).getByText('In testing to Available')).toBeInTheDocument();
  });

  it('does not offer to reserve a unit past its date, but records its expiry', async () => {
    addMockBloodUnit({ id: 'bu_old', unitNumber: 'BU-OLD', expiresAt: '2020-01-01T00:00:00.000Z' });
    await open('BU-OLD');
    const row = rowOf('BU-OLD');
    expect(within(row).getByRole('button', { name: /Reserve/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(row).getByRole('button', { name: /Record expiry/ }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
        'Unit BU-OLD recorded as expired.',
      ),
    );
  });

  it('says a unit was changed by someone else first', async () => {
    addMockBloodUnit({ id: 'bu_r', unitNumber: 'BU-R', status: 'reserved' });
    await open();
    await filterStatus('Reserved');
    await waitFor(() => expect(rowOf('BU-R')).toBeDefined());
    server.use(
      http.post('*/api/blood-units/:unitId/move', () =>
        HttpResponse.json(
          { error: { code: 'conflict', message: 'It has changed', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(within(rowOf('BU-R')).getByRole('button', { name: /Issue/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this unit');
  });
});

describe('access to the blood bank', () => {
  it('is closed without bloodUnit:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodUnit:read');
    renderApp({ entry: '/blood-bank' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Blood bank' })).not.toBeInTheDocument();
  });

  it('offers the bank no ward moves without bloodUnit:issue, and no bank moves without :manage', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodUnit:issue');
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodUnit:manage');
    await open();
    expect(screen.queryByRole('button', { name: /Reserve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discard/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register a unit' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /History/ }).length).toBeGreaterThan(0);
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'bloodbank', false);
    renderApp({ entry: '/blood-bank' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Blood bank' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('has no blood bank at the clinic', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'bloodUnit:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await open();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(screen.queryByRole('link', { name: 'Blood bank' })).not.toBeInTheDocument();
  });
});
