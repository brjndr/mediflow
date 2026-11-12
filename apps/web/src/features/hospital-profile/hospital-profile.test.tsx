import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockHospitalProfile } from '@/mocks/handlers/hospital-profile';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Hospital profile', level: 1 };

const open = async () => {
  const app = renderApp({ entry: '/hospital-profile' });
  await screen.findByRole('heading', HEADING);
  await screen.findByDisplayValue('KA-CE-0000');
  return app;
};
const field = (label: RegExp) => screen.getByRole('textbox', { name: label });
async function fill(label: RegExp, text: string) {
  const input = field(label);
  await userEvent.clear(input);
  if (text) await userEvent.type(input, text);
}
const status = () => within(screen.getByRole('main')).getAllByRole('status')[0]?.textContent;

describe('the hospital profile', () => {
  it('shows the details the letterhead prints', async () => {
    await open();

    expect(field(/^Address/)).toHaveValue(
      '12 Sample Road, Indiranagar\nBengaluru 560038, Karnataka',
    );
    expect(field(/^Phone/)).toHaveValue('+91 80 4000 0000');
    expect(field(/^GSTIN/)).toHaveValue('29ABCDE1234F1Z5');
    await expectNoAxeViolations(document.body);
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Hospital profile' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('saves a change and says so', async () => {
    await open();
    await fill(/^Phone/, '+91 80 9999 0000');
    await fill(/^GSTIN/, '29abcde1234f1z6');
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => expect(status()).toBe('The hospital profile was saved.'));
    expect(field(/^Phone/)).toHaveValue('+91 80 9999 0000');
    expect(field(/^GSTIN/)).toHaveValue('29ABCDE1234F1Z6');
  });

  it('refuses a GSTIN that is not one before sending it', async () => {
    await open();
    await fill(/^GSTIN/, '123');
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText(/A GSTIN has fifteen/)).toBeInTheDocument();
  });

  it('keeps what was typed and shows what the other admin saved', async () => {
    await open();
    await fill(/^Phone/, '111');
    editMockHospitalProfile(TENANT_IDS.hospital, { phone: '222', registrationNumber: 'NEW-1' });
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(
      await screen.findByText(/Someone else changed the hospital profile/),
    ).toBeInTheDocument();
    // Typed value kept, the other field taken from what was saved, and theirs shown.
    expect(field(/^Phone/)).toHaveValue('111');
    await waitFor(() => expect(field(/^Registration number/)).toHaveValue('NEW-1'));
    expect(screen.getByText(/Phone: 222/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(status()).toBe('The hospital profile was saved.'));
  });
});

describe('who may see it', () => {
  it('hides the screen from a role without the permission', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/hospital-profile' });

    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Hospital profile' })).not.toBeInTheDocument();
  });

  it('shows the details without a way to change them to someone who may only read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'hospitalProfile:manage');
    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    await open();

    expect(screen.queryByRole('button', { name: 'Save details' })).not.toBeInTheDocument();
    expect(screen.getByText(/can see these details but not change/)).toBeInTheDocument();
  });
});
