import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setMockDeletionBy, setMockOffboarding } from '@/mocks/handlers/platform';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { fetchHospitalDeletion } from './api';

function asPlatformAdmin() {
  setMockMfa(USER_IDS.platformAdmin, true);
  signIn(USER_IDS.platformAdmin);
}

const dialog = () => screen.getByRole('alertdialog');

describe('deleting an offboarded hospital (platform)', () => {
  it('is not offered for a hospital that is open', async () => {
    asPlatformAdmin();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await screen.findByRole('button', { name: 'Suspend' });
    expect(screen.queryByRole('heading', { name: 'Deleting the data' })).toBeNull();
  });

  it('shows the export, asks first, then requests a deletion', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: true });
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    expect(await screen.findByText(/It was first downloaded on/)).toBeInTheDocument();
    expect(screen.getByText(/has not been requested/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Request deletion' }));
    expect(dialog()).toHaveAccessibleName("Request deletion of City General Hospital's data?");
    expect(await fetchHospitalDeletion('hosp_city')).toBeNull();
    await expectNoAxeViolations();

    await user.click(within(dialog()).getByRole('button', { name: 'Request deletion' }));

    expect(await screen.findByText(/Deletion requested/)).toBeInTheDocument();
    expect(await fetchHospitalDeletion('hosp_city')).toMatchObject({ status: 'requested' });
    // The same admin asked, so a second one has to approve.
    expect(screen.getByText(/second platform admin must approve this request/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve deletion' })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('shows the reason the API refuses with: no downloaded export, then a legal hold', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: false, blocker: 'legal_hold' });
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    expect(await screen.findByText(/It has not been downloaded/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request deletion' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Request deletion' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'The export was not downloaded',
    );

    await user.type(within(dialog()).getByLabelText('Waiver reference'), 'W-12');
    await user.click(within(dialog()).getByRole('button', { name: 'Request deletion' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('A legal hold');
    expect(await fetchHospitalDeletion('hosp_city')).toBeNull();
  });

  it('lets a second admin approve, and the one who asked cancel', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: true });
    setMockDeletionBy('hosp_city', 'user_platform_two');
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    await user.click(await screen.findByRole('button', { name: 'Approve deletion' }));
    expect(dialog()).toHaveAccessibleName("Approve deletion of City General Hospital's data?");
    expect(await fetchHospitalDeletion('hosp_city')).toMatchObject({ status: 'requested' });
    await user.click(within(dialog()).getByRole('button', { name: 'Approve and delete' }));

    expect(await screen.findByText(/Approved. The deletion is queued/)).toBeInTheDocument();
    expect(await fetchHospitalDeletion('hosp_city')).toMatchObject({ status: 'approved' });

    await user.click(screen.getByRole('button', { name: 'Cancel request' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByText('The request was cancelled.')).toBeInTheDocument();
    expect(await fetchHospitalDeletion('hosp_city')).toMatchObject({ status: 'cancelled' });
    // Cancelled: a new request may be made.
    expect(screen.getByRole('button', { name: 'Request deletion' })).toBeInTheDocument();
  });

  it('keeps the request when the cancel question is answered Keep', async () => {
    setMockOffboarding('hosp_city', { downloadedExport: true });
    setMockDeletionBy('hosp_city', 'user_platform_two');
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    await user.click(await screen.findByRole('button', { name: 'Cancel request' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Keep the request' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await fetchHospitalDeletion('hosp_city')).toMatchObject({ status: 'requested' });
  });
});
