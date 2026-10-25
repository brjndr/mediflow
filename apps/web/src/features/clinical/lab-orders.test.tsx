import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockEncounter, mockOrdersOf, moveMockOrder } from '@/mocks/handlers/clinical';
import { editMockLabTest } from '@/mocks/handlers/lab-tests';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const CONSULTATION = { name: 'Consultation', level: 1 };
const LAB_ORDERS = { name: 'Lab orders', level: 2 };

const openConsultation = async (id = 'enc_h_1') => {
  renderApp({ entry: `/encounters/${id}` });
  await screen.findByRole('heading', CONSULTATION);
};

const panel = async () =>
  (await screen.findByRole('heading', LAB_ORDERS)).closest('section') as HTMLElement;

const grid = () => screen.getByRole('table', { name: 'Lab orders' });

/** Searches the catalog from the order form and takes the option named. */
async function chooseTest(search: string, option: RegExp) {
  await userEvent.type(screen.getByRole('combobox', { name: 'Test or panel' }), search);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('lab orders on the consultation', () => {
  it('shows each order with its priority and status in words', async () => {
    await openConsultation();
    const section = await panel();
    const table = await within(section).findByRole('table', { name: 'Lab orders' });
    expect(await within(table).findByText('Complete blood count')).toBeInTheDocument();
    expect(within(table).getByText('Routine')).toBeInTheDocument();
    expect(within(table).getByText('Ordered, waiting for the laboratory')).toBeInTheDocument();
    expect(within(table).getByText('Fasting not needed')).toBeInTheDocument();
    // Results are the laboratory's own panel (#92), not a line here.
    expect(within(section).queryByText(/arrive with the laboratory/)).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('orders a test from the catalog, after asking for one', async () => {
    await openConsultation();
    await panel();
    await userEvent.click(screen.getByRole('button', { name: 'Order the test' }));
    expect(await screen.findByText('Choose a test or panel from the search.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Test or panel' })).toHaveFocus(),
    );

    await chooseTest('haemoglobin', /^Haemoglobin \(HB\), Single test$/);
    expect(screen.getByText('Haemoglobin (HB)')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Change the test, now Haemoglobin' }),
      ).toHaveFocus(),
    );
    await userEvent.selectOptions(
      within(await panel()).getByRole('combobox', { name: /^Priority/ }),
      'Urgent',
    );
    await userEvent.type(
      within(await panel()).getByRole('textbox', { name: /^Instructions/ }),
      'Before the transfusion',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Order the test' }));

    expect(await screen.findByText('Test ordered.')).toBeInTheDocument();
    expect(await within(grid()).findByText('Haemoglobin')).toBeInTheDocument();
    expect(within(grid()).getByText('Urgent')).toBeInTheDocument();
    const placed = mockOrdersOf('enc_h_1').find((order) => order.labTestId === 'lab_h_hb');
    expect(placed).toMatchObject({
      type: 'lab',
      priority: 'urgent',
      status: 'placed',
      instructions: 'Before the transfusion',
    });
    // The form is ready for the next test.
    expect(screen.getByRole('combobox', { name: 'Test or panel' })).toHaveValue('');
  });

  it('warns of a test already ordered in this consultation, and still orders it', async () => {
    await openConsultation();
    await within(await panel()).findByText('Complete blood count');
    await chooseTest('blood count', /^Complete blood count \(CBC\), Panel$/);
    expect(
      screen.getByText(/Already ordered in this consultation and still in effect/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Order the test' }));
    expect(await screen.findByText('Test ordered.')).toBeInTheDocument();
    expect(mockOrdersOf('enc_h_1').filter((order) => order.labTestId === 'lab_h_cbc')).toHaveLength(
      2,
    );
  });

  it('cancels an order not yet started, with a reason, and keeps it marked', async () => {
    await openConsultation();
    await within(await panel()).findByText('Complete blood count');
    await userEvent.click(
      within(grid()).getByRole('button', { name: /^Cancel order: Complete blood count/ }),
    );
    await screen.findByRole('heading', { name: 'Cancel the order for Complete blood count' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Why it is cancelled/ }),
      'Wrong test',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));

    expect(await screen.findByText('Order cancelled.')).toBeInTheDocument();
    expect(await within(grid()).findByText('Cancelled: Wrong test')).toBeInTheDocument();
    expect(
      within(grid()).getByRole('button', { name: /^Cancel order: Complete blood count/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(mockOrdersOf('enc_h_1').find((order) => order.id === 'ord_h_lab_1')).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Wrong test',
    });
  });

  it('cancels after a conflict, from the order as read again', async () => {
    await openConsultation();
    await within(await panel()).findByText('Complete blood count');
    // The laboratory accepts it behind the screen: still cancellable, at a newer version.
    moveMockOrder('ord_h_lab_1', 'accepted');
    await userEvent.click(
      within(grid()).getByRole('button', { name: /^Cancel order: Complete blood count/ }),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Why it is cancelled/ }),
      'Not needed',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    expect(await screen.findByText(/^The order changed meanwhile/)).toBeInTheDocument();
    expect(await within(grid()).findByText('Accepted by the laboratory')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    expect(await screen.findByText('Order cancelled.')).toBeInTheDocument();
    expect(await within(grid()).findByText('Cancelled: Not needed')).toBeInTheDocument();
  });

  it('says so when the laboratory started on the order meanwhile, and sends nothing more', async () => {
    await openConsultation();
    await within(await panel()).findByText('Complete blood count');
    moveMockOrder('ord_h_lab_1', 'in_progress');
    await userEvent.click(
      within(grid()).getByRole('button', { name: /^Cancel order: Complete blood count/ }),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Why it is cancelled/ }),
      'Not needed',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    expect(
      await screen.findByText(
        'The laboratory has started on it, so it can no longer be cancelled.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel the order' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await within(grid()).findByText('In progress at the laboratory')).toBeInTheDocument();
  });

  it('says why an order was refused, and keeps what was typed', async () => {
    await openConsultation();
    await panel();
    await chooseTest('haemoglobin', /^Haemoglobin \(HB\), Single test$/);
    await userEvent.type(
      within(await panel()).getByRole('textbox', { name: /^Instructions/ }),
      'Morning sample',
    );
    // Archived by the laboratory between the search and the press.
    editMockLabTest('lab_h_hb', { archived: true });
    await userEvent.click(screen.getByRole('button', { name: 'Order the test' }));
    expect(
      await screen.findByText('This test is no longer offered by the laboratory. Choose another.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Haemoglobin (HB)')).toBeInTheDocument();
    expect(within(await panel()).getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
      'Morning sample',
    );
  });

  it('keeps a half-filled order while a cancellation is asked', async () => {
    await openConsultation();
    await within(await panel()).findByText('Complete blood count');
    await chooseTest('haemoglobin', /^Haemoglobin \(HB\), Single test$/);
    await userEvent.click(
      within(grid()).getByRole('button', { name: /^Cancel order: Complete blood count/ }),
    );
    expect(screen.queryByRole('button', { name: 'Order the test' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.getByText('Haemoglobin (HB)')).toBeVisible();
  });

  it('cancels on a closed consultation, without ordering more', async () => {
    await openConsultation('enc_h_2');
    const section = await panel();
    expect(await within(section).findByText('Haemoglobin')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Test or panel' })).not.toBeInTheDocument();
    expect(
      within(grid()).getByRole('button', { name: /^Cancel order: Haemoglobin/ }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('offers nothing on a cancelled consultation', async () => {
    const closed = mockEncounter('enc_h_2');
    if (closed) closed.status = 'cancelled';
    await openConsultation('enc_h_2');
    const section = await panel();
    expect(await within(section).findByText('Haemoglobin')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('who sees and orders lab tests', () => {
  it('shows the nurse’s view the orders, without ordering or cancelling', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'order:read' },
      { permission: 'order:update' },
      { permission: 'labTest:read' },
    ]);
    await openConsultation();
    const section = await panel();
    expect(await within(section).findByText('Complete blood count')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('shows nothing of lab orders without order:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'order:read');
    await openConsultation();
    await screen.findByRole('heading', { name: 'Notes' });
    expect(screen.queryByRole('heading', LAB_ORDERS)).not.toBeInTheDocument();
    expect(screen.queryByText('Complete blood count')).not.toBeInTheDocument();
  });

  it('orders for a custom role that holds the permissions', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'order:read' },
      { permission: 'order:create' },
      { permission: 'labTest:read' },
    ]);
    await openConsultation();
    await panel();
    await chooseTest('haemoglobin', /^Haemoglobin \(HB\)/);
    await userEvent.click(screen.getByRole('button', { name: 'Order the test' }));
    expect(await screen.findByText('Test ordered.')).toBeInTheDocument();
    // Ordering without cancelling: no row action is offered.
    expect(within(grid()).queryByRole('button', { name: /^Cancel order/ })).not.toBeInTheDocument();
  });

  it('says the test search is closed when the lab test catalog is off', async () => {
    setTenantFeature(HOSPITAL, 'lab_tests', false);
    await openConsultation();
    await panel();
    expect(screen.getByRole('combobox', { name: 'Test or panel' })).toBeDisabled();
    expect(
      screen.getByText('The lab test catalog is not open to you at this hospital.'),
    ).toBeInTheDocument();
  });

  it('offers no test search without labTest:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'labTest:read');
    await openConsultation();
    await panel();
    expect(screen.getByRole('combobox', { name: 'Test or panel' })).toBeDisabled();
    expect(
      screen.getByText('The lab test catalog is not open to you at this hospital.'),
    ).toBeInTheDocument();
  });

  it('keeps each hospital’s orders and catalog to itself', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    // The clinic took ordering from its doctors; this one is given it back.
    setRolePermissions(CLINIC, 'doctor', [
      { permission: 'encounter:read' },
      { permission: 'order:read' },
      { permission: 'order:create' },
      { permission: 'labTest:read' },
    ]);
    await openConsultation('enc_c_1');
    const section = await panel();
    expect(await within(section).findByText('No test ordered yet.')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox', { name: 'Test or panel' }), 'haemoglobin');
    const options = await within(await screen.findByRole('listbox')).findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Haemoglobin (clinic) (HB), Single test',
    ]);
  });

  it('is unreachable with the module off', async () => {
    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/encounters/enc_h_1' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', LAB_ORDERS)).not.toBeInTheDocument();
  });
});
