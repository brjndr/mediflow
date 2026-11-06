import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { fetchHospital, suspendHospital } from './api';

function asPlatformAdmin() {
  setMockMfa(USER_IDS.platformAdmin, true);
  signIn(USER_IDS.platformAdmin);
}

const dialog = () => screen.getByRole('alertdialog');

describe('suspending, reactivating and offboarding a hospital (platform)', () => {
  it('asks first, then suspends, and keeps the keyboard on the status line', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    await user.click(await screen.findByRole('button', { name: 'Suspend' }));
    expect(dialog()).toHaveAccessibleName('Suspend City General Hospital?');
    // Nothing has happened yet.
    expect((await fetchHospital('hosp_city')).status).toBe('active');
    await expectNoAxeViolations();

    await user.click(within(dialog()).getByRole('button', { name: 'Suspend hospital' }));

    expect(await screen.findByText('The hospital is suspended.')).toBeInTheDocument();
    expect((await fetchHospital('hosp_city')).status).toBe('suspended');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
    // Staff are not asked to be invited into a closed hospital.
    expect(screen.queryByRole('heading', { name: 'First hospital admin' })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does nothing when the question is cancelled', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    await user.click(await screen.findByRole('button', { name: 'Suspend' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await fetchHospital('hosp_city')).status).toBe('active');
  });

  it('reactivates a suspended hospital', async () => {
    asPlatformAdmin();
    await suspendHospital('hosp_clinic');
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_clinic' });

    expect(await screen.findByText(/Suspended on/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reactivate' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Reactivate hospital' }));

    expect(await screen.findByText('The hospital is active again.')).toBeInTheDocument();
    expect(await fetchHospital('hosp_clinic')).toMatchObject({
      status: 'active',
      suspendedAt: null,
    });
  });

  it('offboards only when the slug is typed, with the days, and says nothing is deleted', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    await user.click(await screen.findByRole('button', { name: 'Offboard' }));
    expect(dialog()).toHaveTextContent(/nothing is deleted/);
    const confirm = within(dialog()).getByRole('button', { name: 'Offboard hospital' });

    // The wrong slug is refused and nothing is sent.
    await user.type(within(dialog()).getByLabelText(/Type city-general to confirm/), 'city');
    await user.click(confirm);
    expect(await within(dialog()).findByText("This is not the hospital's slug.")).toBeVisible();
    expect((await fetchHospital('hosp_city')).status).toBe('active');

    // So are days that are not a whole number of days.
    const slug = within(dialog()).getByLabelText(/Type city-general to confirm/);
    await user.clear(slug);
    await user.type(slug, 'city-general');
    const days = within(dialog()).getByLabelText(/Days until/);
    await user.clear(days);
    await user.type(days, '0');
    await user.click(confirm);
    expect(await within(dialog()).findByText(/Enter a whole number/)).toBeVisible();
    expect((await fetchHospital('hosp_city')).status).toBe('active');

    await user.clear(days);
    await user.type(days, '30');
    await user.click(confirm);

    expect(await screen.findByText('Offboarding has started.')).toBeInTheDocument();
    const saved = await fetchHospital('hosp_city');
    expect(saved.status).toBe('offboarding');
    expect(saved.deleteAfter).not.toBeNull();
    expect(
      screen.getByText(/Its data may be deleted after .*nothing is deleted yet/),
    ).toBeVisible();
    // An offboarding hospital is reactivated, not offboarded again.
    expect(screen.queryByRole('button', { name: 'Offboard' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('cancels an offboarding by reactivating, which clears the dates', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await user.click(await screen.findByRole('button', { name: 'Offboard' }));
    await user.type(within(dialog()).getByLabelText(/Type city-general/), 'city-general');
    await user.click(within(dialog()).getByRole('button', { name: 'Offboard hospital' }));
    await screen.findByText('Offboarding has started.');

    await user.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(dialog()).toHaveTextContent(/cancels the offboarding/);
    await user.click(within(dialog()).getByRole('button', { name: 'Reactivate hospital' }));

    await screen.findByText('The hospital is active again.');
    expect(await fetchHospital('hosp_city')).toMatchObject({
      status: 'active',
      offboardingRequestedAt: null,
      deleteAfter: null,
    });
  });

  it('shows the real status when someone else changed it first', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await user.click(await screen.findByRole('button', { name: 'Suspend' }));
    // Someone else suspends it while the question is open.
    await suspendHospital('hosp_city');

    await user.click(within(dialog()).getByRole('button', { name: 'Suspend hospital' }));

    // The question closes, the page says why, and shows the status the hospital really has.
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('forgets what was typed when the offboard question is cancelled', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await user.click(await screen.findByRole('button', { name: 'Offboard' }));
    await user.type(within(dialog()).getByLabelText(/Type city-general/), 'city-gen');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Offboard' }));
    expect(within(dialog()).getByLabelText(/Type city-general/)).toHaveValue('');
    expect((await fetchHospital('hosp_city')).status).toBe('active');
  });

  it('refuses days above the limit', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await user.click(await screen.findByRole('button', { name: 'Offboard' }));
    await user.type(within(dialog()).getByLabelText(/Type city-general/), 'city-general');
    const days = within(dialog()).getByLabelText(/Days until/);
    await user.clear(days);
    await user.type(days, '3651');
    await user.click(within(dialog()).getByRole('button', { name: 'Offboard hospital' }));

    expect(await within(dialog()).findByText('Enter a whole number from 1 to 3650.')).toBeVisible();
    expect((await fetchHospital('hosp_city')).status).toBe('active');
  });

  it('is out of reach for hospital staff', async () => {
    signIn(USER_IDS.admin);
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  });
});
