import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Legal holds (#628): placed from the Documents tab, listed and released on the retention screen.

const HOSPITAL = TENANT_IDS.hospital;

const rowOf = (table: HTMLElement, text: string) =>
  within(table)
    .getAllByRole('row')
    .find((row) => within(row).queryByText(text)) as HTMLElement;

async function holdOneDocument(reason: string) {
  renderApp({ entry: '/patients/pth_00001?tab=documents' });
  await screen.findByRole('tab', { name: 'Documents', selected: true });
  const table = await screen.findByRole('table', { name: 'Documents' });
  await within(table).findByText('Insurance card');
  await userEvent.click(
    within(rowOf(table, 'Signed consent for surgery')).getByRole('button', { name: /^Hold/ }),
  );
  await userEvent.type(await screen.findByLabelText(/Reason/), reason);
  await userEvent.click(screen.getByRole('button', { name: 'Place hold' }));
  expect(await screen.findByText('Legal hold placed on the document.')).toBeInTheDocument();
}

describe('placing a legal hold', () => {
  it('holds one document, which then shows in the list of holds and can be released', async () => {
    await holdOneDocument('Court order 12');
    await userEvent.click(screen.getAllByRole('link', { name: 'Document retention' })[0]!);
    const table = await screen.findByRole('table', { name: 'Legal holds' });
    expect(await within(table).findByText('Court order 12')).toBeInTheDocument();
    expect(within(table).getByText('One document')).toBeInTheDocument();
    await expectNoAxeViolations();

    await userEvent.click(within(table).getByRole('button', { name: /^Release/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Release this hold?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Release' }));
    expect(await screen.findByText('Legal hold released.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Court order 12')).toBeNull());
  });

  it('holds every document of a patient', async () => {
    renderApp({ entry: '/patients/pth_00001?tab=documents' });
    await screen.findByRole('tab', { name: 'Documents', selected: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Hold all documents' }));
    await userEvent.type(await screen.findByLabelText(/Reason/), 'Investigation');
    await userEvent.click(screen.getByRole('button', { name: 'Place hold' }));
    expect(
      await screen.findByText('Legal hold placed on the documents of this patient.'),
    ).toBeInTheDocument();
  });

  it('asks for a reason', async () => {
    renderApp({ entry: '/patients/pth_00001?tab=documents' });
    await screen.findByRole('tab', { name: 'Documents', selected: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Hold all documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Place hold' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('offers no hold without documentRetention:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'documentRetention:manage');
    renderApp({ entry: '/patients/pth_00001?tab=documents' });
    const table = await screen.findByRole('table', { name: 'Documents' });
    await within(table).findByText('Insurance card');
    expect(screen.queryByRole('button', { name: /^Hold/ })).toBeNull();
  });

  it('lists holds but offers no release without documentRetention:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'documentRetention:manage');
    renderApp({ entry: '/document-retention' });
    expect(await screen.findByRole('table', { name: 'Legal holds' })).toBeInTheDocument();
    expect(await screen.findByText('No active legal holds.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Release/ })).toBeNull();
  });
});
