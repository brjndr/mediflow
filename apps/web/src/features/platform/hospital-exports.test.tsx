import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MOCK_ADMIN_ID, setMockOffboarding } from '@/mocks/handlers/platform';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
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

  it('lists the exports with their downloads and makes a link for an admin', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: true });
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    const heading = await screen.findByRole('heading', { name: 'Exports' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findByText('Ready')).toBeInTheDocument();
    expect(within(section).getByText(/1 time\(s\)/)).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: /Make a download link/ }));
    await expectNoAxeViolations();

    // Not an admin of the hospital: the API's reason is shown.
    await user.type(
      within(dialog()).getByLabelText(/Admin user id/),
      MOCK_ADMIN_ID.replace('1', '2'),
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Make link' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('not an active admin');

    await user.clear(within(dialog()).getByLabelText(/Admin user id/));
    await user.type(within(dialog()).getByLabelText(/Admin user id/), MOCK_ADMIN_ID);
    await user.click(within(dialog()).getByRole('button', { name: 'Make link' }));

    const field = await within(section).findByLabelText('Download link');
    expect((field as HTMLInputElement).value).toContain('/offboarding-exports/export_hosp_city');
    expect(within(section).getByText(/is not sent to anyone/)).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
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
