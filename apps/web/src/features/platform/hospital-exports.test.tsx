import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK_ADMIN_ID, setMockOffboarding } from '@/mocks/handlers/platform';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

function asPlatformAdmin() {
  setMockMfa(USER_IDS.platformAdmin, true);
  signIn(USER_IDS.platformAdmin);
}

const dialog = () => screen.getByRole('alertdialog');

describe('offboarding exports (platform)', () => {
  it('is not offered for a hospital that is open', async () => {
    asPlatformAdmin();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await screen.findByRole('button', { name: 'Suspend' });
    expect(screen.queryByRole('heading', { name: 'Exports' })).toBeNull();
  });

  it('lists the exports with their downloads and emails a link to an admin', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: true });
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    const heading = await screen.findByRole('heading', { name: 'Exports' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findByText('Ready')).toBeInTheDocument();
    expect(within(section).getByText(/1 time\(s\)/)).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: /Email a download link/ }));
    await expectNoAxeViolations();

    // Not an admin of the hospital: the API's reason is shown.
    await user.type(
      within(dialog()).getByLabelText(/Admin user id/),
      MOCK_ADMIN_ID.replace('1', '2'),
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Send link' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'cannot receive the export',
    );

    await user.clear(within(dialog()).getByLabelText(/Admin user id/));
    await user.type(within(dialog()).getByLabelText(/Admin user id/), MOCK_ADMIN_ID);
    await user.click(within(dialog()).getByRole('button', { name: 'Send link' }));

    expect(
      await within(section).findByText(/emailed to that admin. It works for 7 days/),
    ).toBeInTheDocument();
    expect(within(section).queryByLabelText('Download link')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('says when nobody at the hospital can receive the export', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: true });
    server.use(
      http.post('*/api/platform/hospitals/:id/exports/:exportId/email-link', () =>
        HttpResponse.json(
          { error: { code: 'export_has_no_recipient', message: 'Nobody' } },
          { status: 409 },
        ),
      ),
    );
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    const heading = await screen.findByRole('heading', { name: 'Exports' });
    const section = heading.closest('section') as HTMLElement;
    await user.click(await within(section).findByRole('button', { name: /Email a download link/ }));
    await user.type(within(dialog()).getByLabelText(/Admin user id/), MOCK_ADMIN_ID);
    await user.click(within(dialog()).getByRole('button', { name: 'Send link' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Nobody at this hospital can receive the export',
    );
  });

  it('starts another export, and refuses a second while one is queued', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: false });
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    const heading = await screen.findByRole('heading', { name: 'Exports' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findByText('Never downloaded')).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Start a new export' }));
    expect(await within(section).findByText('Queued')).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Start a new export' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'already queued or running',
    );
  });
});
