import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { addMockProgressNote } from '@/mocks/handlers/nursing-notes';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const NO_ACCESS = { name: 'You do not have access to this page' };
const NOTES = { name: 'Progress notes' };

beforeEach(() => {
  addMockAdmission({ id: 'adm_r1', patientName: 'Asha Verma', doctorId: 'doc_h_01' });
  addMockAdmission({ id: 'adm_r2', patientName: 'Ravi Kumar', doctorId: 'doc_h_02' });
});

describe('the doctor rounds list', () => {
  it('lists admitted patients and narrows to one doctor', async () => {
    renderApp({ entry: '/nursing/rounds' });
    await screen.findByRole('heading', { name: 'Doctor rounds', level: 1 });
    const grid = await screen.findByRole('table', { name: 'Patients on rounds' });
    expect(await within(grid).findByRole('row', { name: /Asha Verma/ })).toBeInTheDocument();
    expect(within(grid).getByRole('row', { name: /Ravi Kumar/ })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Doctor' }), 'doc_h_02');
    await waitFor(() =>
      expect(within(grid).queryByRole('row', { name: /Asha Verma/ })).not.toBeInTheDocument(),
    );
    const row = within(grid).getByRole('row', { name: /Ravi Kumar/ });
    await expectNoAxeViolations();
    await userEvent.click(within(row).getByRole('button', { name: /Progress notes/ }));
    expect(
      await screen.findByRole('heading', { name: /Progress notes: Ravi Kumar/, level: 1 }),
    ).toBeInTheDocument();
  }, 30_000);

  it('is unreachable without the permission or with the module off', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'progressNote:read');
    renderApp({ entry: '/nursing/rounds' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable with the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'nursing', false);
    renderApp({ entry: '/nursing/adm_r1/notes' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});

describe('progress notes', () => {
  const open = async () => {
    renderApp({ entry: '/nursing/adm_r1/notes' });
    await screen.findByRole('heading', { name: /Progress notes: Asha Verma/, level: 1 });
  };

  it('adds a note and amends it, keeping every version', async () => {
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: /Note/ }), 'Afebrile, eating well.');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Note added.'));
    const grid = screen.getByRole('table', NOTES);
    const row = await within(grid).findByRole('row', { name: /Afebrile, eating well/ });
    expect(within(row).getByText('Afebrile, eating well.')).toBeInTheDocument();
    expect(within(row).getByText('Original')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: /Amend/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Amend note' });
    const text = within(dialog).getByRole('textbox', { name: /Note/ });
    await userEvent.clear(text);
    await userEvent.type(text, 'Afebrile, discharge planned.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save amendment' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Note amended.'));
    const amended = await within(grid).findByText(/Amended \(version 2\)/);
    const amendedRow = amended.closest('tr') ?? amended.closest('[role="row"]');
    expect(amendedRow).not.toBeNull();

    await userEvent.click(
      within(amendedRow as HTMLElement).getByRole('button', { name: /History/ }),
    );
    const history = await screen.findByRole('dialog', { name: 'Note history' });
    const versions = await within(history).findAllByRole('listitem');
    expect(versions).toHaveLength(2);
    expect(versions[0]).toHaveTextContent('Version 2');
    expect(versions[0]).toHaveTextContent('Afebrile, discharge planned.');
    expect(versions[1]).toHaveTextContent('Afebrile, eating well.');
  }, 40_000);

  it('refuses an empty note', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Write the note.')).toBeInTheDocument();
  });

  it('does not offer to amend a note somebody else wrote, and shows only this hospital', async () => {
    addMockProgressNote({ id: 'n_other', admissionId: 'adm_r1', body: 'Seen on rounds.' });
    addMockProgressNote({
      id: 'n_clinic',
      admissionId: 'adm_r1',
      tenantId: TENANT_IDS.clinic,
      body: 'Another hospital.',
    });
    await open();
    const grid = screen.getByRole('table', NOTES);
    const row = await within(grid).findByRole('row', { name: /Seen on rounds/ });
    expect(within(row).getByText('Seen on rounds.')).toBeInTheDocument();
    expect(within(grid).queryByText('Another hospital.')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Amend/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expectNoAxeViolations();
  }, 30_000);

  it('hides the form without the write permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'progressNote:write');
    await open();
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
  });
});
