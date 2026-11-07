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
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Housekeeping', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const grid = () => screen.getByRole('table', { name: 'Cleaning tasks' });
const rowOf = (bed: string) =>
  within(grid())
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === bed) as HTMLElement;

const open = async () => {
  renderApp({ entry: '/housekeeping' });
  await screen.findByRole('heading', HEADING);
  await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBeGreaterThan(1));
};

describe('housekeeping tasks', () => {
  it('lists the open tasks with their bed and ward', async () => {
    await open();
    const row = rowOf('GW-A-03');
    expect(within(row).getByText('General Ward A')).toBeInTheDocument();
    expect(within(row).getByText('After discharge')).toBeInTheDocument();
    expect(within(row).getByText('Open')).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 20_000);

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Housekeeping' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('starts a task, finishes it and says the bed is available', async () => {
    await open();
    await userEvent.click(within(rowOf('GW-A-03')).getByRole('button', { name: /Start/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('started'));

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'In progress');
    await waitFor(() => expect(rowOf('GW-A-03')).toBeDefined());
    expect(within(rowOf('GW-A-03')).getByRole('button', { name: /Start/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(rowOf('GW-A-03')).getByRole('button', { name: /Finish/ }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Bed GW-A-03 is clean and available.'),
    );
  });

  it('cancels an open task', async () => {
    await open();
    await userEvent.click(within(rowOf('GW-A-03')).getByRole('button', { name: /Cancel task/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('cancelled'));
  });

  it('says a task was changed by someone else first', async () => {
    await open();
    server.use(
      http.post('*/api/cleaning-tasks/:taskId/move', () =>
        HttpResponse.json(
          { error: { code: 'conflict', message: 'It has changed', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(within(rowOf('GW-A-03')).getByRole('button', { name: /Start/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this task');
  });
});

describe('access to housekeeping', () => {
  it('is closed without cleaningTask:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'cleaningTask:read');
    renderApp({ entry: '/housekeeping' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Housekeeping' })).not.toBeInTheDocument();
  });

  it('offers no start or finish without cleaningTask:work, no cancel without :manage', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'cleaningTask:work');
    revokePermission(TENANT_IDS.hospital, 'admin', 'cleaningTask:manage');
    await open();
    expect(screen.queryByRole('button', { name: /Start/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel task/ })).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'housekeeping', false);
    renderApp({ entry: '/housekeeping' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Housekeeping' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('has no housekeeping at the clinic', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'cleaningTask:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await open();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(screen.queryByRole('link', { name: 'Housekeeping' })).not.toBeInTheDocument();
  });
});
