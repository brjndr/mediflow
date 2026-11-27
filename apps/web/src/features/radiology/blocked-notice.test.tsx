import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/node';
import { revokePermission, setTenantFeature, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { blockMockImage } from '@/mocks/handlers/radiology';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The uploader is told about a blocked radiology image on the home page, whatever screen they
// left (#926).

const HOSPITAL = TENANT_IDS.hospital;
const TITLE = 'Images that were blocked';
const NONE = 'None of the images you uploaded was blocked.';

describe('the blocked image notice on the home page', () => {
  it('names the uploader’s blocked image until they dismiss it', async () => {
    blockMockImage(HOSPITAL, USER_IDS.admin, 'chest-pa.jpg');
    renderApp({ entry: '/' });
    expect(await screen.findByText('chest-pa.jpg')).toBeInTheDocument();
    expect(screen.getByText(/failed the virus scan and was deleted/i)).toBeInTheDocument();
    await expectNoAxeViolations();

    await userEvent.click(
      screen.getByRole('button', { name: /Dismiss the notice for chest-pa.jpg/ }),
    );
    expect(await screen.findByText(NONE)).toBeInTheDocument();
    // The button left the page: focus went to the status line, which says so.
    const status = screen.getByRole('status', { name: '' });
    expect(status).toHaveTextContent('Notice dismissed.');
    await waitFor(() => expect(status).toHaveFocus());
  });

  it('says so, and keeps the notice, when dismissing fails', async () => {
    blockMockImage(HOSPITAL, USER_IDS.admin, 'chest-pa.jpg', 'failed');
    server.use(
      http.post('*/api/radiology/images/:imageId/dismiss-blocked', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'x' } }, { status: 500 }),
      ),
    );
    renderApp({ entry: '/' });
    expect(await screen.findByText('chest-pa.jpg')).toBeInTheDocument();
    expect(screen.getByText(/could not be scanned or never arrived/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Dismiss the notice for/ }));
    expect(
      await screen.findByText('The notice could not be dismissed. Try again.'),
    ).toBeInTheDocument();
    expect(screen.getByText('chest-pa.jpg')).toBeInTheDocument();
  });

  it('says nothing about an image somebody else uploaded, or another hospital’s', async () => {
    blockMockImage(HOSPITAL, 'user_someone_else', 'other.jpg');
    blockMockImage(TENANT_IDS.clinic, USER_IDS.admin, 'elsewhere.jpg');
    renderApp({ entry: '/' });
    expect(await screen.findByText(NONE)).toBeInTheDocument();
    expect(screen.queryByText('other.jpg')).not.toBeInTheDocument();
    expect(screen.queryByText('elsewhere.jpg')).not.toBeInTheDocument();
  });

  it('is absent without the right to perform studies', async () => {
    revokePermission(HOSPITAL, 'admin', 'imagingStudy:perform');
    renderApp({ entry: '/' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { name: TITLE })).not.toBeInTheDocument();
  });

  it('is absent when the radiology module is off', async () => {
    setTenantFeature(HOSPITAL, 'radiology', false);
    renderApp({ entry: '/' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { name: TITLE })).not.toBeInTheDocument();
  });
});
