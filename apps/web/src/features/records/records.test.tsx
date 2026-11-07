import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The records desk (MR-04, #192): incomplete records, the coding queue and the record request
// log. The mock's hospital has three incomplete records, two diagnoses waiting for a code and
// two open requests (one overdue); its clinic has one of each.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

describe('incomplete records', () => {
  it('lists what is missing, oldest first, and has no axe violations', async () => {
    renderApp({ entry: '/records' });
    const table = await screen.findByRole('table', { name: 'Incomplete records' });
    expect(await within(table).findByText('Note not signed, No diagnosis')).toBeInTheDocument();
    expect(within(table).getByText('No discharge summary')).toBeInTheDocument();
    expect(within(table).getByText('No signed consent')).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Outpatient')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('narrows the list by what is missing', async () => {
    renderApp({ entry: '/records' });
    const table = await screen.findByRole('table', { name: 'Incomplete records' });
    await within(table).findByText('No signed consent');
    await userEvent.selectOptions(screen.getByLabelText('What is missing'), 'No signed consent');
    await waitFor(() =>
      expect(within(table).queryByText('No discharge summary')).not.toBeInTheDocument(),
    );
    expect(within(table).getByText('No signed consent')).toBeInTheDocument();
  });

  it('shows another hospital only its own records', async () => {
    setTenantFeature(CLINIC, 'records', true);
    grantPermission(CLINIC, 'doctor', 'medicalRecord:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/records' });
    const table = await screen.findByRole('table', { name: 'Incomplete records' });
    await within(table).findByText('No diagnosis');
    expect(within(table).queryByText('No signed consent')).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(HOSPITAL, 'records', false);
    renderApp({ entry: '/records' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('table', { name: 'Incomplete records' })).not.toBeInTheDocument();
  });

  it('is refused without the permission', async () => {
    revokePermission(HOSPITAL, 'admin', 'medicalRecord:read');
    renderApp({ entry: '/records' });
    expect(await screen.findByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
  });
});

describe('the coding queue', () => {
  it('codes a diagnosis from the code search and takes it off the queue', async () => {
    renderApp({ entry: '/records/coding' });
    const table = await screen.findByRole('table', { name: 'Coding queue' });
    expect(await within(table).findByText('Viral fever with body ache')).toBeInTheDocument();
    expect(within(table).queryByText('Hypertension')).not.toBeInTheDocument();
    const row = within(table).getByText('Viral fever with body ache').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Add or change code/ }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save code' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'ICD-10 code' }), 'J06');
    await userEvent.click(await within(dialog).findByRole('option', { name: /J06\.9/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save code' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(within(table).queryByText('Viral fever with body ache')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Code saved/);
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'Coded');
    expect(await within(table).findByText('Viral fever with body ache')).toBeInTheDocument();
  });

  it('offers no coding without medicalRecord:code', async () => {
    revokePermission(HOSPITAL, 'admin', 'medicalRecord:code');
    renderApp({ entry: '/records/coding' });
    const table = await screen.findByRole('table', { name: 'Coding queue' });
    await within(table).findByText('Viral fever with body ache');
    expect(within(table).queryByRole('button', { name: /Add or change code/ })).toBeNull();
  });
});

describe('the record request log', () => {
  it('lists open requests and marks the one past its day', async () => {
    renderApp({ entry: '/records/requests' });
    const table = await screen.findByRole('table', { name: 'Record requests' });
    expect(await within(table).findByText('Open, overdue')).toBeInTheDocument();
    expect(within(table).getByText('Sample Insurance Co (Insurer)')).toBeInTheDocument();
    expect(within(table).queryByText('District Court (Court or police)')).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('logs a request for a patient', async () => {
    renderApp({ entry: '/records/requests' });
    await screen.findByRole('table', { name: 'Record requests' });
    await userEvent.click(await screen.findByRole('button', { name: 'Log a request' }));
    const dialog = await screen.findByRole('dialog');
    // Nothing is sent without a patient or a purpose.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Log request' }));
    expect(await within(dialog).findAllByText('This field is required.')).not.toHaveLength(0);
    expect(await within(dialog).findByText('Choose a patient.')).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByRole('combobox', { name: /Patient/ }),
      'MRN-PTH-00001',
    );
    await userEvent.click(await within(dialog).findByRole('option', { name: /MRN-PTH-00001/ }));
    expect(
      await within(dialog).findByRole('button', { name: 'Change patient' }),
    ).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Name of the person/), 'Meera Rao');
    await userEvent.type(within(dialog).getByLabelText(/Purpose/), 'Copy for a visa file');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Log request' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Meera Rao (Patient)')).toBeInTheDocument();
  });

  it('closes a request with a note and keeps it out of the open list', async () => {
    renderApp({ entry: '/records/requests' });
    const table = await screen.findByRole('table', { name: 'Record requests' });
    const row = (await within(table).findByText('Sample Insurance Co (Insurer)')).closest(
      'tr',
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Close request/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Note/), 'Sent by courier');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close request' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(within(table).queryByText('Sample Insurance Co (Insurer)')).not.toBeInTheDocument(),
    );
  });

  it('does not offer to log or close without recordRequest:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'recordRequest:manage');
    renderApp({ entry: '/records/requests' });
    const table = await screen.findByRole('table', { name: 'Record requests' });
    await within(table).findByText('Open, overdue');
    expect(screen.queryByRole('button', { name: 'Log a request' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /Close request/ })).toBeNull();
  });
});
