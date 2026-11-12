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
  // The first rows can show before the bed's own row has arrived: wait for it.
  await waitFor(() => expect(rowOf('GW-A-03')).toBeDefined());
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

describe('requesting a routine cleaning', () => {
  const chooseFreeBed = async (dialog: HTMLElement) => {
    await within(dialog).findByRole('option', { name: 'General ward A' });
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /Ward/ }),
      'General ward A',
    );
    const bed = within(dialog).getByRole('combobox', { name: /^Bed/ });
    await waitFor(() => expect(within(bed).getAllByRole('option').length).toBeGreaterThan(1));
    const option = within(bed).getAllByRole('option')[1] as HTMLOptionElement;
    await userEvent.selectOptions(bed, option);
    return option.textContent?.split(' ')[0] ?? '';
  };
  const openRequest = async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Request a cleaning' }));
    return screen.findByRole('dialog');
  };

  it('picks a free bed, assigns a person and lists the new task', async () => {
    const dialog = await openRequest();
    const number = await chooseFreeBed(dialog);
    await userEvent.type(
      within(dialog).getByRole('combobox', { name: 'Assign to' }),
      'Sample Admin',
    );
    await userEvent.click(await within(dialog).findByRole('option', { name: 'Sample Admin' }));
    expect(await within(dialog).findByRole('button', { name: 'Change' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Request cleaning' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(`Cleaning of bed ${number} requested`),
    );
    await waitFor(() => expect(rowOf(number)).toBeDefined());
    expect(within(rowOf(number)).getByText('Routine')).toBeInTheDocument();
  }, 20_000);

  it('finds a person past the first hundred by searching', async () => {
    const people = Array.from({ length: 150 }, (_, index) => ({
      id: `stf_big_${index}`,
      tenantId: TENANT_IDS.hospital,
      name: `Person ${String(index).padStart(3, '0')}`,
      email: `p${index}@sample-hospital.test`,
      roleId: 'nurse',
      roleName: 'Nurse',
      status: 'active',
    }));
    let body: { assignedTo?: string } = {};
    server.use(
      http.get('*/api/staff', ({ request }) => {
        const params = new URL(request.url).searchParams;
        const q = (params.get('q') ?? '').toLowerCase();
        const items = people
          .filter((person) => person.name.toLowerCase().includes(q))
          .slice(0, Math.min(Number(params.get('limit') ?? 25), 100));
        return HttpResponse.json({ items, nextCursor: null, total: items.length });
      }),
      http.post('*/api/cleaning-tasks', async ({ request }) => {
        body = (await request.json()) as { assignedTo?: string };
        return HttpResponse.json(
          { error: { code: 'bed_not_available', message: 'x', requestId: 'r' } },
          { status: 409 },
        );
      }),
    );
    const dialog = await openRequest();
    await chooseFreeBed(dialog);
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Assign to' }), 'Person 140');
    await userEvent.click(await within(dialog).findByRole('option', { name: 'Person 140' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Request cleaning' }));
    await waitFor(() => expect(body.assignedTo).toBe('stf_big_140'));
  }, 20_000);

  it('needs a bed before it asks', async () => {
    const dialog = await openRequest();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Request cleaning' }));
    expect(await within(dialog).findByText(/required/i)).toBeInTheDocument();
  });

  it('says so when the bed is taken meanwhile', async () => {
    server.use(
      http.post('*/api/cleaning-tasks', () =>
        HttpResponse.json(
          { error: { code: 'bed_not_available', message: 'x', requestId: 'r' } },
          { status: 409 },
        ),
      ),
    );
    const dialog = await openRequest();
    await chooseFreeBed(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Request cleaning' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('in use or blocked');
  }, 20_000);

  it('is not offered without cleaningTask:manage', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'cleaningTask:manage');
    await open();
    expect(screen.queryByRole('button', { name: 'Request a cleaning' })).not.toBeInTheDocument();
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
