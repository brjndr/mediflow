import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The fields of each certificate, set by the hospital (#567).

const HOSPITAL = TENANT_IDS.hospital;

async function openPage() {
  renderApp({ entry: '/certificate-formats' });
  await screen.findByRole('heading', { level: 1, name: 'Certificate formats' });
  return screen.findByRole('table', { name: 'Certificate formats' });
}

async function changeFields(kind: string) {
  const table = await openPage();
  await within(table).findByText(kind);
  const row = within(table)
    .getAllByRole('row')
    .find((one) => within(one).queryByText(kind)) as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: /^Change fields/ }));
  return screen.findByRole('heading', { name: `Fields of the ${kind} certificate` });
}

describe('the certificate formats screen', () => {
  it('lists the four kinds with their standard fields, and has no axe violations', async () => {
    const table = await openPage();
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(5));
    expect(within(table).getByText(/Diagnosis, Rest advised from/)).toBeInTheDocument();
    expect(within(table).getAllByText('Standard')).toHaveLength(4);
    await expectNoAxeViolations();
  });

  it('changes the fields of a kind, and the list shows them', async () => {
    await changeFields('Medical');
    // Relabel the first field, make the remarks required, add a field of our own.
    const labels = screen.getAllByLabelText(/^Label/);
    await userEvent.type(labels[0]!, 'Illness');
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Must be filled in' })[3]!);
    await userEvent.click(screen.getByRole('button', { name: 'Add a field' }));
    const added = screen.getAllByLabelText(/^Label/).at(-1)!;
    await userEvent.type(added, 'Employer');
    await userEvent.click(screen.getByRole('button', { name: 'Remove field 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the fields' }));
    expect(
      await screen.findByText('The fields of the Medical certificate were saved.'),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Illness, Rest advised until, Remarks, Employer/)).toBeVisible();
    expect(screen.getByText('Changed by this hospital')).toBeInTheDocument();
  });

  it('goes back to the standard fields', async () => {
    await changeFields('Death');
    await userEvent.click(screen.getByRole('button', { name: 'Remove field 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the fields' }));
    await screen.findByText('The fields of the Death certificate were saved.');
    const table = screen.getByRole('table', { name: 'Certificate formats' });
    await within(table).findByText('Changed by this hospital');
    const row = within(table)
      .getAllByRole('row')
      .find((one) => within(one).queryByText('Death')) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Change fields/ }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Back to the standard fields' }),
    );
    expect(
      await screen.findByText('The Death certificate uses the standard fields again.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(table).queryByText('Changed by this hospital')).toBeNull());
  });

  it('refuses a field of our own with no label', async () => {
    await changeFields('Fitness');
    await userEvent.click(screen.getByRole('button', { name: 'Add a field' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the fields' }));
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThan(0);
  });
});

describe('a changed format on the patient screen', () => {
  it('asks for the changed fields, and a certificate issued earlier keeps its own', async () => {
    await changeFields('Medical');
    await userEvent.click(screen.getByRole('button', { name: 'Remove field 4' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add a field' }));
    await userEvent.type(screen.getAllByLabelText(/^Label/).at(-1)!, 'Employer');
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Must be filled in' }).at(-1)!);
    await userEvent.click(screen.getByRole('button', { name: 'Save the fields' }));
    await screen.findByText('The fields of the Medical certificate were saved.');

    // The same session, now on the patient's tab (the mock keeps its state between screens).
    cleanup();
    renderApp({ entry: '/patients/pth_00001?tab=consents' });
    const certificates = await screen.findByRole('table', { name: 'Certificates' });
    await within(certificates).findByText('MED-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Issue a certificate' }));
    expect(await screen.findByLabelText(/^Employer/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Remarks/)).toBeNull();
    await userEvent.type(screen.getByLabelText(/^Diagnosis/), 'Fever');
    await userEvent.type(screen.getByLabelText(/^Rest advised from/), '2026-11-02');
    await userEvent.type(screen.getByLabelText(/^Rest advised until/), '2026-11-04');
    await userEvent.type(screen.getByLabelText(/^Employer/), 'Acme');
    await userEvent.click(screen.getByRole('button', { name: 'Issue the certificate' }));
    expect(await screen.findByText(/Certificate MED-\d{4}-0002 was issued\./)).toBeInTheDocument();

    // The one issued before the change still reads with the fields it had.
    await userEvent.click(within(certificates).getAllByRole('button', { name: /^View/ }).at(-1)!);
    expect(await screen.findByText('Viral fever')).toBeInTheDocument();
  }, 30_000);
});

describe('who can change the formats', () => {
  it('has no screen without certificate:configure', async () => {
    revokePermission(HOSPITAL, 'admin', 'certificate:configure');
    renderApp({ entry: '/certificate-formats' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Certificate formats' })).toBeNull(),
    );
    expect(screen.queryByRole('table', { name: 'Certificate formats' })).toBeNull();
  });

  it('has no screen when the module is off for the hospital', async () => {
    setTenantFeature(HOSPITAL, 'consents', false);
    renderApp({ entry: '/certificate-formats' });
    await waitFor(() =>
      expect(screen.queryByRole('table', { name: 'Certificate formats' })).toBeNull(),
    );
    expect(screen.queryByRole('heading', { level: 1, name: 'Certificate formats' })).toBeNull();
  });
});
