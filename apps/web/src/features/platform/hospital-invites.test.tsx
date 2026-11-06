import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { createHospital, fetchAdminInvites, inviteHospitalAdmin } from './api';

function asPlatformAdmin() {
  setMockMfa(USER_IDS.platformAdmin, true);
  signIn(USER_IDS.platformAdmin);
}

/** A hospital with no staff yet, so it has no admin. */
async function newHospital() {
  return createHospital(
    {
      slug: 'lakeside',
      name: 'Lakeside Clinic',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      themePrimary: '#0f766e',
      features: ['patients'],
    },
    crypto.randomUUID(),
  );
}

describe('inviting the first hospital admin (platform)', () => {
  it('invites by email, lists the invite, and sends it again without a duplicate', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    const hospital = await newHospital();
    renderApp({ entry: `/platform/hospitals/${hospital.id}` });

    await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Asha Rao');
    await user.type(screen.getByRole('textbox', { name: /^Email address/ }), 'Asha@Lakeside.test');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(await screen.findByText('Invite sent to asha@lakeside.test.')).toBeInTheDocument();
    const grid = await screen.findByRole('table', { name: 'Open invites' });
    expect(within(grid).getByText('asha@lakeside.test')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('');
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: /Send again/ }));
    await screen.findAllByText('Invite sent to asha@lakeside.test.');
    expect((await fetchAdminInvites(hospital.id)).items).toHaveLength(1);
  });

  it('withdraws an invite and moves focus on', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    const hospital = await newHospital();
    await inviteHospitalAdmin(hospital.id, { name: 'Asha Rao', email: 'asha@lakeside.test' });
    renderApp({ entry: `/platform/hospitals/${hospital.id}` });

    await user.click(await screen.findByRole('button', { name: /Withdraw/ }));

    expect(await screen.findByText('Invite to asha@lakeside.test withdrawn.')).toBeInTheDocument();
    expect(await screen.findByText('No open invites.')).toBeInTheDocument();
    expect(document.body).not.toBe(document.activeElement);
    expect((await fetchAdminInvites(hospital.id)).items).toEqual([]);
  });

  it('validates the address before sending anything', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    const hospital = await newHospital();
    renderApp({ entry: `/platform/hospitals/${hospital.id}` });

    await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Asha Rao');
    await user.type(screen.getByRole('textbox', { name: /^Email address/ }), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(await screen.findByText(/not in the expected format/)).toBeInTheDocument();
    expect((await fetchAdminInvites(hospital.id)).items).toEqual([]);
  });

  it('says so when the hospital already has an admin', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });

    await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Asha Rao');
    await user.type(screen.getByRole('textbox', { name: /^Email address/ }), 'asha@city.test');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(await screen.findByText(/already has an admin/)).toBeInTheDocument();
  });

  it('is out of reach for hospital staff', async () => {
    signIn(USER_IDS.admin);
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'First hospital admin' })).toBeNull();
  });
});
