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
import { mockOrdersOf, moveMockOrder } from '@/mocks/handlers/clinical';
import { editMockService, mockServiceNamed } from '@/mocks/handlers/services';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const CONSULTATION = { name: 'Consultation', level: 1 };
const IMAGING = { name: 'Imaging orders', level: 2 };
const PROCEDURES = { name: 'Procedure orders', level: 2 };

const openConsultation = async (id = 'enc_h_1') => {
  renderApp({ entry: `/encounters/${id}` });
  await screen.findByRole('heading', CONSULTATION);
};

const panel = async (heading: typeof IMAGING) =>
  (await screen.findByRole('heading', heading)).closest('section') as HTMLElement;

/** Searches the panel's catalog and takes the option named. */
async function choose(section: HTMLElement, box: string, search: string, option: RegExp) {
  await userEvent.type(within(section).getByRole('combobox', { name: box }), search);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('imaging orders on the consultation', () => {
  it('shows each order with its priority and status in words, and where reports come from', async () => {
    await openConsultation();
    const section = await panel(IMAGING);
    const table = await within(section).findByRole('table', { name: 'Imaging orders' });
    expect(await within(table).findByText('Chest X-ray')).toBeInTheDocument();
    expect(within(table).getByText('Urgent')).toBeInTheDocument();
    expect(within(table).getByText('Ordered, waiting for radiology')).toBeInTheDocument();
    expect(within(table).getByText('PA view. Cough for three weeks.')).toBeInTheDocument();
    expect(within(section).getByText(/they arrive with the radiology module/)).toBeInTheDocument();
    // Each kind keeps to its own list.
    const lab = await panel({ name: 'Lab orders', level: 2 });
    expect(await within(lab).findByText('Complete blood count')).toBeInTheDocument();
    expect(within(lab).queryByText('Chest X-ray')).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('orders a study from the imaging services, after asking for one', async () => {
    await openConsultation();
    const section = await panel(IMAGING);
    await userEvent.click(within(section).getByRole('button', { name: 'Order the study' }));
    expect(await within(section).findByText('Choose a study from the search.')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(section).getByRole('combobox', { name: 'Study' })).toHaveFocus(),
    );

    await choose(section, 'Study', 'ultra', /^Abdominal ultrasound \(IMG-002\)$/);
    await waitFor(() =>
      expect(
        within(section).getByRole('button', { name: 'Change the study, now Abdominal ultrasound' }),
      ).toHaveFocus(),
    );
    await userEvent.selectOptions(
      within(section).getByRole('combobox', { name: /^Priority/ }),
      'Immediately (stat)',
    );
    await userEvent.type(
      within(section).getByRole('textbox', { name: /^Instructions/ }),
      'Right iliac fossa pain',
    );
    await userEvent.click(within(section).getByRole('button', { name: 'Order the study' }));

    expect(await within(section).findByText('Imaging ordered.')).toBeInTheDocument();
    const table = within(section).getByRole('table', { name: 'Imaging orders' });
    expect(await within(table).findByText('Abdominal ultrasound')).toBeInTheDocument();
    const placed = mockOrdersOf('enc_h_1').find(
      (order) => order.itemName === 'Abdominal ultrasound',
    );
    expect(placed).toMatchObject({
      type: 'imaging',
      itemCode: 'IMG-002',
      priority: 'stat',
      status: 'placed',
      instructions: 'Right iliac fossa pain',
    });
    expect(placed?.serviceId).toBeDefined();
    expect(placed?.labTestId).toBeUndefined();
  });

  it('offers imaging services only', async () => {
    await openConsultation();
    const section = await panel(IMAGING);
    // "ec" is also in procedures (ECG, Injection): only the imaging service is offered.
    await userEvent.type(within(section).getByRole('combobox', { name: 'Study' }), 'ec');
    const options = await within(await screen.findByRole('listbox')).findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Echocardiography (IMG-005)']);
  });

  it('warns of a study already ordered in this consultation', async () => {
    await openConsultation();
    const section = await panel(IMAGING);
    await within(section).findByText('Chest X-ray');
    await choose(section, 'Study', 'chest', /^Chest X-ray \(IMG-001\)$/);
    expect(
      within(section).getByText(/Already ordered in this consultation and still in effect/),
    ).toBeInTheDocument();
  });

  it('says why an order was refused, and keeps what was typed', async () => {
    await openConsultation();
    const section = await panel(IMAGING);
    await choose(section, 'Study', 'mri', /^MRI brain/);
    await userEvent.type(
      within(section).getByRole('textbox', { name: /^Instructions/ }),
      'Seizure',
    );
    // Archived between the search and the press.
    editMockService(mockServiceNamed(HOSPITAL, 'MRI brain')?.id ?? '', { archived: true });
    await userEvent.click(within(section).getByRole('button', { name: 'Order the study' }));
    expect(
      await within(section).findByText(
        'This study is no longer offered by the hospital. Choose another.',
      ),
    ).toBeInTheDocument();
    expect(within(section).getByText('MRI brain (IMG-004)')).toBeInTheDocument();
    expect(within(section).getByRole('textbox', { name: /^Instructions/ })).toHaveValue('Seizure');
  });

  it('cancels a study not yet started, and says so once radiology started on one', async () => {
    await openConsultation();
    const section = await panel(IMAGING);
    const table = await within(section).findByRole('table', { name: 'Imaging orders' });
    await within(table).findByText('Chest X-ray');
    moveMockOrder('ord_h_img_1', 'in_progress');
    await userEvent.click(
      within(table).getByRole('button', { name: /^Cancel order: Chest X-ray/ }),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Why it is cancelled/ }),
      'Not needed',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    expect(
      await screen.findByText('Radiology has started on it, so it can no longer be cancelled.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await within(table).findByText('In progress in radiology')).toBeInTheDocument();
  });
});

describe('procedure orders on the consultation', () => {
  it('orders a procedure from the procedure services, and cancels it', async () => {
    await openConsultation();
    const section = await panel(PROCEDURES);
    expect(await within(section).findByText('No procedure ordered yet.')).toBeInTheDocument();
    expect(within(section).queryByText(/arrive with/)).not.toBeInTheDocument();

    await choose(section, 'Procedure', 'dress', /^Wound dressing \(PRO-001\)$/);
    await userEvent.click(within(section).getByRole('button', { name: 'Order the procedure' }));
    expect(await within(section).findByText('Procedure ordered.')).toBeInTheDocument();
    const table = within(section).getByRole('table', { name: 'Procedure orders' });
    expect(await within(table).findByText('Ordered, waiting to be done')).toBeInTheDocument();
    expect(
      mockOrdersOf('enc_h_1').find((order) => order.itemName === 'Wound dressing'),
    ).toMatchObject({ type: 'procedure', itemCode: 'PRO-001', priority: 'routine' });

    await userEvent.click(
      within(table).getByRole('button', { name: /^Cancel order: Wound dressing/ }),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Why it is cancelled/ }),
      'Done at the dressing room',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    expect(await within(section).findByText('Order cancelled.')).toBeInTheDocument();
    expect(
      await within(table).findByText('Cancelled: Done at the dressing room'),
    ).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('offers no imaging service as a procedure', async () => {
    await openConsultation();
    const section = await panel(PROCEDURES);
    await userEvent.type(within(section).getByRole('combobox', { name: 'Procedure' }), 'x-ray');
    expect(await within(section).findAllByText('No service matches.')).not.toHaveLength(0);
  });
});

describe('who sees and orders imaging and procedures', () => {
  it('shows the nurse’s view the orders, without ordering or cancelling', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'order:read' },
      { permission: 'order:update' },
      { permission: 'service:read' },
    ]);
    await openConsultation();
    const imaging = await panel(IMAGING);
    expect(await within(imaging).findByText('Chest X-ray')).toBeInTheDocument();
    expect(within(imaging).queryByRole('button')).not.toBeInTheDocument();
    expect(within(await panel(PROCEDURES)).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('shows nothing of imaging or procedures without order:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'order:read');
    await openConsultation();
    await screen.findByRole('heading', { name: 'Notes' });
    expect(screen.queryByRole('heading', IMAGING)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', PROCEDURES)).not.toBeInTheDocument();
    expect(screen.queryByText('Chest X-ray')).not.toBeInTheDocument();
  });

  it('says the search is closed without service:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'service:read');
    await openConsultation();
    const section = await panel(IMAGING);
    expect(within(section).getByRole('combobox', { name: 'Study' })).toBeDisabled();
    expect(
      within(section).getByText('The service catalog is not open to you at this hospital.'),
    ).toBeInTheDocument();
  });

  it('says the search is closed with the services module off', async () => {
    setTenantFeature(HOSPITAL, 'services', false);
    await openConsultation();
    const section = await panel(PROCEDURES);
    expect(within(section).getByRole('combobox', { name: 'Procedure' })).toBeDisabled();
    // The lab test search does not depend on it.
    const lab = await panel({ name: 'Lab orders', level: 2 });
    expect(within(lab).getByRole('combobox', { name: 'Test or panel' })).toBeEnabled();
  });

  it('keeps each hospital’s orders and services to itself', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    setRolePermissions(CLINIC, 'doctor', [
      { permission: 'encounter:read' },
      { permission: 'order:read' },
      { permission: 'order:create' },
      { permission: 'service:read' },
    ]);
    await openConsultation('enc_c_1');
    const imaging = await panel(IMAGING);
    expect(await within(imaging).findByText('No imaging ordered yet.')).toBeInTheDocument();
    await userEvent.type(within(imaging).getByRole('combobox', { name: 'Study' }), 'chest');
    expect(await within(imaging).findAllByText('No service matches.')).not.toHaveLength(0);

    const procedures = await panel(PROCEDURES);
    await choose(procedures, 'Procedure', 'vacc', /^Vaccination \(PRO-001\)$/);
    await userEvent.click(within(procedures).getByRole('button', { name: 'Order the procedure' }));
    expect(await within(procedures).findByText('Procedure ordered.')).toBeInTheDocument();
    expect(mockOrdersOf('enc_c_1')).toEqual([
      expect.objectContaining({ tenantId: CLINIC, type: 'procedure', itemName: 'Vaccination' }),
    ]);
  });
});
