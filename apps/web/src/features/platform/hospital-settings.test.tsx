import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/node';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { fetchHospital, setHospitalFeatures, updateHospital } from './api';

function asPlatformAdmin() {
  setMockMfa(USER_IDS.platformAdmin, true);
  signIn(USER_IDS.platformAdmin);
}

describe('hospital modules and limits (platform)', () => {
  it('opens a hospital from the list', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals' });

    await user.click(await screen.findByRole('link', { name: 'Riverside Clinic' }));

    expect(
      await screen.findByRole('heading', { name: 'Riverside Clinic', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'Patients' })).toBeChecked();
    expect(await screen.findByRole('checkbox', { name: 'Laboratory' })).not.toBeChecked();
    await expectNoAxeViolations();
  });

  it('shows a module the API lists that the web app has no name for, by its id', async () => {
    asPlatformAdmin();
    server.use(
      http.get('*/api/platform/modules', () =>
        HttpResponse.json({
          items: [
            { id: 'patients', kind: 'module' },
            { id: 'new_thing', kind: 'module' },
            { id: 'mfa', kind: 'switch' },
          ],
        }),
      ),
    );
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    expect(await screen.findByRole('checkbox', { name: 'new_thing' })).not.toBeChecked();
    expect(await screen.findByRole('checkbox', { name: 'Patients' })).toBeChecked();
    // Only what the API lists, so no stale web list: Laboratory is not offered.
    expect(screen.queryByRole('checkbox', { name: 'Laboratory' })).not.toBeInTheDocument();
  });

  it('offers the records, roles and consents switches by name', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    for (const name of ['Medical records', 'Roles and permissions', 'Consents and certificates']) {
      const box = await screen.findByRole('checkbox', { name });
      expect(box).not.toBeChecked();
      await user.click(box);
      expect(box).toBeChecked();
    }
  });

  it('switches a module on and keeps it after a reload of the hospital', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    await user.click(await screen.findByRole('checkbox', { name: 'Laboratory' }));
    await user.click(screen.getByRole('button', { name: 'Save modules' }));

    expect(await screen.findByText('Modules saved.')).toBeInTheDocument();
    const saved = await fetchHospital('hosp_city');
    expect(saved.features).toContainEqual({ feature: 'laboratory', enabled: true });
  });

  it('turns the compulsory authenticator off with the authenticator', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    const required = await screen.findByRole('checkbox', { name: 'Make it compulsory' });
    // Without the authenticator offered, it cannot be ticked.
    await user.click(required);
    expect(required).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Offer the authenticator to staff' }));
    await user.click(required);
    expect(required).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save modules' }));
    await screen.findByText('Modules saved.');

    await user.click(screen.getByRole('checkbox', { name: 'Offer the authenticator to staff' }));
    await user.click(screen.getByRole('button', { name: 'Save modules' }));
    await waitFor(async () => {
      const h = await fetchHospital('hosp_city');
      expect(h.features).toContainEqual({ feature: 'mfa', enabled: false });
      expect(h.features).toContainEqual({ feature: 'mfa_required', enabled: false });
    });
  });

  it('never sends the compulsory switch on while the authenticator goes off', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_clinic' });

    const offer = await screen.findByRole('checkbox', { name: 'Offer the authenticator to staff' });
    await user.click(offer);
    await user.click(screen.getByRole('checkbox', { name: 'Make it compulsory' }));
    // Both ticked, then the authenticator is unticked again before saving.
    await user.click(offer);
    await user.click(screen.getByRole('button', { name: 'Save modules' }));

    // Nothing changed from what was saved: nothing is sent, and nothing is on.
    const h = await fetchHospital('hosp_clinic');
    expect(h.features.find((f) => f.feature === 'mfa_required')?.enabled ?? false).toBe(false);
    expect(h.features.find((f) => f.feature === 'mfa')?.enabled ?? false).toBe(false);
  });

  it('shows a flag the web list does not know, by its id', async () => {
    asPlatformAdmin();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await screen.findByRole('checkbox', { name: 'Patients' });
    await setHospitalFeatures('hosp_city', [{ feature: 'telehealth', enabled: true }]);
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    expect((await screen.findAllByRole('checkbox', { name: 'telehealth' }))[0]).toBeChecked();
  });

  it('saves limits and refuses a value that is not a whole number', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    const users = await screen.findByLabelText(/Most staff accounts/);
    await user.type(users, '12,5');
    await user.tab();
    expect(await screen.findByText(/Enter a whole number above zero/)).toBeInTheDocument();

    await user.clear(users);
    await user.type(users, '150');
    await user.type(screen.getByLabelText(/Storage \(MB\)/), '5000');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));

    expect(await screen.findByText('Limits saved.')).toBeInTheDocument();
    const saved = await fetchHospital('hosp_city');
    expect(saved).toMatchObject({ maxUsers: 150, storageMb: 5000, version: 2 });
  });

  it('keeps what was typed when someone else saved first, and shows their value', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    const users = await screen.findByLabelText(/Most staff accounts/);
    await user.type(users, '40');
    // Someone else saves the same limit meanwhile.
    await updateHospital('hosp_city', { version: 1, maxUsers: 90 });

    await user.click(screen.getByRole('button', { name: 'Save limits' }));

    expect(await screen.findByText(/Someone else changed this hospital/)).toBeInTheDocument();
    expect(await screen.findByText(/Saved by someone else/)).toBeInTheDocument();
    expect(users).toHaveValue('40');

    // Saving again sends the typed value over the newest version.
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(await screen.findByText('Limits saved.')).toBeInTheDocument();
    expect((await fetchHospital('hosp_city')).maxUsers).toBe(40);
  });

  it('says so for a hospital that does not exist', async () => {
    asPlatformAdmin();
    renderApp({ entry: '/platform/hospitals/nope' });
    expect(await screen.findByText('Hospital not found')).toBeInTheDocument();
  });

  it('gives a hospital admin no access', async () => {
    signIn(USER_IDS.admin);
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save modules' })).not.toBeInTheDocument();
  });
});
