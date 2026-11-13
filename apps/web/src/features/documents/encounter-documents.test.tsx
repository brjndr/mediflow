import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Documents of a visit (#562): a "Documents" button on the consultation lists the files attached
// to that visit and attaches new ones to it.

const HOSPITAL = TENANT_IDS.hospital;

async function openPanel() {
  renderApp({ entry: '/encounters/enc_h_1' });
  await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
  return screen.findByRole('table', { name: 'Documents of this visit' });
}

describe('documents of a visit', () => {
  it('attaches a file to the visit and lists only the visit documents', async () => {
    const table = await openPanel();
    // The patient's other documents are not the visit's.
    expect(await screen.findByText('No documents attached to this visit.')).toBeInTheDocument();
    expect(screen.queryByText('Insurance card')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Add document' }));
    await userEvent.upload(
      screen.getByLabelText('File'),
      new File(['%PDF-1.4 hello'], 'ward-note.pdf', { type: 'application/pdf' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText(/ward-note was uploaded/)).toBeInTheDocument();
    expect(await within(table).findByText('ward-note.pdf')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('is not offered without document:read, nor with the module off', async () => {
    revokePermission(HOSPITAL, 'admin', 'document:read');
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('link', { name: 'Create invoice' });
    expect(screen.queryByRole('button', { name: 'Documents' })).toBeNull();
  });

  it('is gone when the documents switch is off', async () => {
    setTenantFeature(HOSPITAL, 'documents', false);
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('link', { name: 'Create invoice' });
    expect(screen.queryByRole('button', { name: 'Documents' })).toBeNull();
  });

  it('hides "Add document" without document:upload', async () => {
    revokePermission(HOSPITAL, 'admin', 'document:upload');
    await openPanel();
    await waitFor(() =>
      expect(screen.getByText('No documents attached to this visit.')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Add document' })).toBeNull();
  });
});
