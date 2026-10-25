import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockOrdersOf } from '@/mocks/handlers/clinical';
import { mockPatient } from '@/mocks/handlers/patients';
import { mockStudies } from '@/mocks/handlers/radiology';
import { server } from '@/mocks/node';
import { nextDay, todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Radiology's worklist (#96). The clinical mock's hospital has one imaging order placed:
// `ord_h_img_1`, an urgent chest X-ray (an X-ray service) of pth_00001 on enc_h_1. The clinic
// has radiology switched off.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const LIST = { name: 'Radiology worklist', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const ORDER = 'ord_h_img_1';
const SLOT = 15 * 60_000;

afterEach(() => {
  server.events.removeAllListeners();
});

const patient = () => mockPatient(HOSPITAL, 'pth_00001')?.name ?? '';
const grid = () => screen.getByRole('table', { name: LIST.name });
const study = () => mockStudies().find((each) => each.orderId === ORDER);
const orderStatus = () => mockOrdersOf('enc_h_1').find((each) => each.id === ORDER)?.status;
const action = (name: string) =>
  within(grid()).getByRole('button', { name: `${name}: ${patient()}, Chest X-ray` });

/** Calls the mock as another member of staff would, behind the open screen. */
async function post(path: string, body?: unknown) {
  const response = await fetch(new URL(`/api${path}`, window.location.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** The start of a slot to come, as the API takes it. */
const slot = (steps = 1) => new Date((Math.floor(Date.now() / SLOT) + steps) * SLOT).toISOString();

async function openWorklist() {
  renderApp({ entry: '/radiology' });
  await screen.findByRole('heading', LIST);
}

const chooseStage = (stage: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), stage);

describe('the radiology worklist', () => {
  it('lists the orders to schedule with their modality, filtered on the server', async () => {
    await openWorklist();
    await within(grid()).findByText(patient());
    const row = within(grid()).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByText('Chest X-ray')).toBeInTheDocument();
    expect(within(row).getByText('X-ray')).toBeInTheDocument();
    expect(within(row).getByText('Urgent')).toBeInTheDocument();
    expect(within(row).getByText('Not scheduled')).toBeInTheDocument();
    expect(screen.getByText('1 study.')).toBeInTheDocument();
    // The MRN is masked in the list.
    expect(within(grid()).queryByText(mockPatient(HOSPITAL, 'pth_00001')?.mrn ?? '')).toBeNull();
    await expectNoAxeViolations(document.body);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Modality' }), 'CT');
    expect(await within(grid()).findByText('No imaging orders to schedule.')).toBeInTheDocument();
  });

  it('schedules a study for a slot, which accepts the order', { timeout: 15_000 }, async () => {
    await openWorklist();
    await within(grid()).findByText(patient());
    await userEvent.click(action('Schedule'));
    const panel = await screen.findByRole('region', { name: 'Schedule Chest X-ray' });
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();
    expect(within(panel).getByLabelText(/^Day/)).toHaveAttribute('type', 'date');
    await expectNoAxeViolations(document.body);

    await userEvent.click(within(panel).getByRole('button', { name: 'Schedule study' }));
    await waitFor(() => expect(study()?.scheduledAt).toBeDefined());
    expect(orderStatus()).toBe('accepted');
    expect(screen.queryByRole('region', { name: 'Schedule Chest X-ray' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      `Chest X-ray for ${patient()} scheduled for`,
    );
    expect(screen.getByRole('status')).toHaveFocus();

    await chooseStage('Scheduled');
    await within(grid()).findByText(patient());
    expect(action('Mark as performed')).toBeInTheDocument();
    expect(action('Reschedule')).toBeInTheDocument();
    expect(action('Unschedule')).toBeInTheDocument();
  });

  it('sends the day and time chosen as that instant on the hospital’s clock', async () => {
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/schedule'))
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body));
    });
    await openWorklist();
    await within(grid()).findByText(patient());
    await userEvent.click(action('Schedule'));
    const panel = await screen.findByRole('region', { name: 'Schedule Chest X-ray' });
    expect(within(panel).getByText('Date of birth')).toBeInTheDocument();
    // Tomorrow at the hospital (Asia/Kolkata, five and a half hours ahead of UTC), at 09:30.
    const day = nextDay(todayIn('Asia/Kolkata'));
    fireEvent.change(within(panel).getByLabelText(/^Day/), { target: { value: day } });
    await userEvent.selectOptions(within(panel).getByLabelText(/^Start time/), '09:30');
    await userEvent.click(within(panel).getByRole('button', { name: 'Schedule study' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ scheduledAt: zonedToUtc(day, '09:30', 'Asia/Kolkata') });
    expect(bodies[0]).toEqual({ scheduledAt: `${day}T04:00:00.000Z` });

    // Rescheduling opens on the study's own slot.
    await chooseStage('Scheduled');
    await within(grid()).findByText(patient());
    await userEvent.click(action('Reschedule'));
    const again = await screen.findByRole('region', { name: 'Reschedule Chest X-ray' });
    expect(within(again).getByLabelText(/^Day/)).toHaveValue(day);
    expect(within(again).getByLabelText(/^Start time/)).toHaveValue('09:30');
  });

  it('refuses a day outside the window on the form', async () => {
    await openWorklist();
    await within(grid()).findByText(patient());
    await userEvent.click(action('Schedule'));
    const panel = await screen.findByRole('region', { name: 'Schedule Chest X-ray' });
    const day = within(panel).getByLabelText(/^Day/);
    await userEvent.clear(day);
    await userEvent.type(day, '2020-01-01');
    await userEvent.click(within(panel).getByRole('button', { name: 'Schedule study' }));
    expect(
      await within(panel).findByText('Choose a day from today to 90 days ahead.'),
    ).toBeInTheDocument();
    expect(day).toHaveFocus();
    expect(study()).toBeUndefined();
  });

  it('performs a scheduled study, and unschedules another', { timeout: 15_000 }, async () => {
    await post(`/radiology/orders/${ORDER}/schedule`, { scheduledAt: slot() });
    await openWorklist();
    await chooseStage('Scheduled');
    await within(grid()).findByText(patient());

    await userEvent.click(action('Unschedule'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Chest X-ray for ${patient()} unscheduled. It is back to schedule.`,
    );
    expect(study()?.scheduledAt).toBeUndefined();
    expect(await within(grid()).findByText('No studies are scheduled.')).toBeInTheDocument();

    await post(`/radiology/orders/${ORDER}/schedule`, { scheduledAt: slot(2), version: 2 });
    await chooseStage('To schedule');
    await chooseStage('Scheduled');
    await within(grid()).findByText(patient());
    await userEvent.click(action('Mark as performed'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Chest X-ray for ${patient()} marked as performed. It now waits for its report.`,
    );
    expect(orderStatus()).toBe('in_progress');
    await chooseStage('Performed, awaiting report');
    const row = await within(grid()).findByText(patient());
    expect(row).toBeInTheDocument();
    expect(within(grid()).getByText(/^Performed .* by /)).toBeInTheDocument();
    // A performed study offers nothing more until reports exist (#97).
    expect(within(grid()).queryByRole('button', { name: /^Reschedule/ })).toBeNull();
  });

  it('says when a study was moved meanwhile, and offers nothing more to send', async () => {
    await post(`/radiology/orders/${ORDER}/schedule`, { scheduledAt: slot() });
    await openWorklist();
    await chooseStage('Scheduled');
    await within(grid()).findByText(patient());
    await userEvent.click(action('Reschedule'));
    const panel = await screen.findByRole('region', { name: 'Reschedule Chest X-ray' });
    // Someone else moves it first.
    await post(`/radiology/orders/${ORDER}/schedule`, { scheduledAt: slot(3), version: 1 });
    await userEvent.selectOptions(within(panel).getByLabelText(/^Start time/), '23:45');
    await userEvent.click(within(panel).getByRole('button', { name: 'Schedule study' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('Someone changed this study meanwhile.');
    expect(alert).toHaveFocus();
    expect(within(panel).queryByRole('button', { name: 'Schedule study' })).toBeNull();
    expect(study()?.scheduledAt).toBe(slot(3));
  });
});

describe('who reaches radiology', () => {
  it('shows a role that only reads the worklist no action that changes it', async () => {
    await post(`/radiology/orders/${ORDER}/schedule`, { scheduledAt: slot() });
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'imagingStudy:read' }]);
    await openWorklist();
    expect(screen.getByRole('link', { name: 'Radiology' })).toBeInTheDocument();
    await chooseStage('Scheduled');
    await within(grid()).findByText(patient());
    expect(within(grid()).queryByRole('button', { name: /^Mark as performed/ })).toBeNull();
    expect(within(grid()).queryByRole('button', { name: /^Reschedule/ })).toBeNull();
  });

  it('lets a custom role that performs studies perform, and not schedule', async () => {
    await post(`/radiology/orders/${ORDER}/schedule`, { scheduledAt: slot() });
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'imagingStudy:read' },
      { permission: 'imagingStudy:perform' },
    ]);
    await openWorklist();
    await chooseStage('Scheduled');
    await within(grid()).findByText(patient());
    expect(action('Mark as performed')).toBeInTheDocument();
    expect(within(grid()).queryByRole('button', { name: /^Reschedule/ })).toBeNull();
    expect(within(grid()).queryByRole('button', { name: /^Unschedule/ })).toBeNull();
  });

  it('is unreachable without imagingStudy:read, and with radiology off', async () => {
    revokePermission(HOSPITAL, 'admin', 'imagingStudy:read');
    const app = renderApp({ entry: '/radiology' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Radiology' })).toBeNull();
    app.unmount();

    setTenantFeature(HOSPITAL, 'radiology', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/radiology' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('keeps each hospital’s worklist and studies to itself', async () => {
    setTenantFeature(CLINIC, 'radiology', true);
    signIn(USER_IDS.doctor, CLINIC);
    setRolePermissions(CLINIC, 'doctor', [
      { permission: 'imagingStudy:read' },
      { permission: 'imagingStudy:schedule' },
      { permission: 'imagingStudy:perform' },
    ]);
    renderApp({ entry: '/radiology' });
    await screen.findByRole('heading', LIST);
    expect(await within(grid()).findByText('No imaging orders to schedule.')).toBeInTheDocument();
    expect(within(grid()).queryByText('Chest X-ray')).toBeNull();

    // The hospital's order does not exist as far as the clinic is concerned.
    expect(
      await post(`/radiology/orders/${ORDER}/schedule`, { scheduledAt: slot() }),
    ).toMatchObject({ error: { code: 'order_not_found' } });
    expect(await post(`/radiology/orders/${ORDER}/perform`, { version: 1 })).toMatchObject({
      error: { code: 'order_not_found' },
    });
    expect(study()).toBeUndefined();
  });
});
