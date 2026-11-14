import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { blockMockDocument } from '@/mocks/handlers/documents';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The uploader is told about a blocked file on the home page, after leaving the Documents
// tab (#673). The mock's hospital has a scanning document, doc_h_3.

const HOSPITAL = TENANT_IDS.hospital;
const TITLE = 'Files that were blocked';

describe('the blocked file notice on the home page', () => {
  it('names the uploader’s blocked file until they dismiss it', async () => {
    blockMockDocument('doc_h_3', USER_IDS.admin);
    renderApp({ entry: '/' });
    expect(await screen.findByText(/Insurance card/)).toBeInTheDocument();
    expect(screen.getByText(/failed the virus scan and was deleted/)).toBeInTheDocument();
    await expectNoAxeViolations();

    await userEvent.click(
      screen.getByRole('button', { name: /Dismiss the notice for Insurance card/ }),
    );
    expect(
      await screen.findByText('None of the files you attached was blocked.'),
    ).toBeInTheDocument();
  });

  it('says nothing about a file somebody else attached', async () => {
    blockMockDocument('doc_h_3', 'user_someone_else');
    renderApp({ entry: '/' });
    expect(
      await screen.findByText('None of the files you attached was blocked.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Insurance card/)).not.toBeInTheDocument();
  });

  it('is absent without the right to upload, or with the module off', async () => {
    revokePermission(HOSPITAL, 'admin', 'document:upload');
    const first = renderApp({ entry: '/' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { name: TITLE })).not.toBeInTheDocument();
    first.unmount();
  });

  it('is absent when the documents module is off', async () => {
    setTenantFeature(HOSPITAL, 'documents', false);
    renderApp({ entry: '/' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { name: TITLE })).not.toBeInTheDocument();
  });
});
