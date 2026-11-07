import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { finishMockScan, mockDocumentAudit } from '@/mocks/handlers/documents';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Patient documents (#189): the "Documents" tab of the patient's screen. The mock's hospital
// has three documents on pth_00001: two ready, one still being scanned.

const HOSPITAL = TENANT_IDS.hospital;
const TABLE = { name: 'Documents' };

afterEach(() => vi.restoreAllMocks());

async function openTab() {
  renderApp({ entry: '/patients/pth_00001?tab=documents' });
  await screen.findByRole('tab', { name: 'Documents', selected: true });
  return screen.findByRole('table', TABLE);
}

const rowOf = (table: HTMLElement, text: string) =>
  within(table)
    .getAllByRole('row')
    .find((row) => within(row).queryByText(text)) as HTMLElement;

describe('the documents tab', () => {
  it('lists the newest first with category, size and state, and has no axe violations', async () => {
    const table = await openTab();
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Insurance card')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Being scanned')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Chest X-ray from another hospital')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('opens a scanned file through a signed link, audited, and not one still being scanned', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const table = await openTab();
    await within(table).findByText('Insurance card');
    const waiting = within(rowOf(table, 'Insurance card')).getByRole('button', { name: /^Open/ });
    expect(waiting).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(waiting);
    expect(open).not.toHaveBeenCalled();

    await userEvent.click(
      within(rowOf(table, 'Signed consent for surgery')).getByRole('button', { name: /^Open/ }),
    );
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(String(open.mock.calls[0]?.[0])).toContain('/document-files/doc_h_2');
    expect(await screen.findByText('Opened Signed consent for surgery.')).toBeInTheDocument();
    expect(mockDocumentAudit(HOSPITAL)).toContainEqual({
      tenantId: HOSPITAL,
      documentId: 'doc_h_2',
      action: 'export',
    });
    // Every document listed was audited as read.
    expect(mockDocumentAudit(HOSPITAL).filter((entry) => entry.action === 'read')).toHaveLength(3);

    finishMockScan('doc_h_3');
  });

  it('filters by category on the server', async () => {
    const table = await openTab();
    await within(table).findByText('Insurance card');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'consent');
    await waitFor(() => expect(within(table).queryByText('Insurance card')).toBeNull());
    expect(within(table).getByText('Signed consent for surgery')).toBeInTheDocument();
  });

  it('uploads a file and lists it', async () => {
    const table = await openTab();
    await within(table).findByText('Insurance card');
    await userEvent.click(screen.getByRole('button', { name: 'Add document' }));
    await screen.findByRole('heading', { name: 'Add a document' });
    await userEvent.upload(
      screen.getByLabelText('File'),
      new File(['%PDF-1.4 hello'], 'lab-report.pdf', { type: 'application/pdf' }),
    );
    expect(screen.getByLabelText(/^Title/)).toHaveValue('lab-report');
    const form = screen.getByRole('heading', { name: 'Add a document' })
      .parentElement as HTMLElement;
    await userEvent.selectOptions(within(form).getByLabelText(/^Category/), 'outside_report');
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText(/lab-report was uploaded/)).toBeInTheDocument();
    expect(await within(table).findByText('lab-report.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a document' })).toBeNull();
  });

  it('refuses a type or a size the API does not take before sending anything', async () => {
    const table = await openTab();
    await within(table).findByText('Insurance card');
    await userEvent.click(screen.getByRole('button', { name: 'Add document' }));
    const input = await screen.findByLabelText('File');
    await userEvent.upload(
      input,
      new File(['MZ'], 'virus.exe', { type: 'application/x-msdownload' }),
      { applyAccept: false },
    );
    expect(await screen.findByText('Only a JPEG, PNG or PDF can be added.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Title/), 'Whatever');
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(screen.getByText('Only a JPEG, PNG or PDF can be added.')).toBeInTheDocument();
    expect(screen.queryByText(/was uploaded/)).toBeNull();

    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    await userEvent.upload(input, big);
    expect(await screen.findByText('The file is larger than 25 MB.')).toBeInTheDocument();
  });

  it('retires a document with a reason, which then leaves the list', async () => {
    const table = await openTab();
    await within(table).findByText('Insurance card');
    await userEvent.click(
      within(rowOf(table, 'Signed consent for surgery')).getByRole('button', { name: /^Retire/ }),
    );
    await screen.findByRole('heading', { name: 'Retire Signed consent for surgery' });
    await userEvent.type(screen.getByLabelText(/^Reason/), 'Uploaded to the wrong record');
    await userEvent.click(screen.getByRole('button', { name: 'Retire' }));
    expect(await screen.findByText('Signed consent for surgery was retired.')).toBeInTheDocument();
    await waitFor(() => expect(within(table).queryByText('Signed consent for surgery')).toBeNull());

    await userEvent.click(screen.getByLabelText('Show retired documents'));
    expect(await within(table).findByText('Signed consent for surgery')).toBeInTheDocument();
    expect(within(table).getByText('Retired: Uploaded to the wrong record')).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('offers no upload or retire without document:upload and document:retire', async () => {
    revokePermission(HOSPITAL, 'admin', 'document:upload');
    revokePermission(HOSPITAL, 'admin', 'document:retire');
    const table = await openTab();
    await within(table).findByText('Insurance card');
    expect(screen.queryByRole('button', { name: 'Add document' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Retire/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Open/ }).length).toBeGreaterThan(0);
  });

  it('has no tab without document:read, and reads nothing', async () => {
    revokePermission(HOSPITAL, 'admin', 'document:read');
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('heading', { level: 1 });
    await screen.findByRole('tab', { name: /Overview|Details/i }).catch(() => undefined);
    expect(screen.queryByRole('tab', { name: 'Documents' })).toBeNull();
    expect(mockDocumentAudit(HOSPITAL)).toEqual([]);
  });

  it('has no tab when the documents module is off for the hospital', async () => {
    setTenantFeature(HOSPITAL, 'documents', false);
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('tab', { name: 'Documents' })).toBeNull();
    expect(mockDocumentAudit(HOSPITAL)).toEqual([]);
  });
});
