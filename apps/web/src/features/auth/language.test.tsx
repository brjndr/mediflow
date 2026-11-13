import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render';
import { setMockLanguage, setTenantLocale, TENANT_IDS, USER_IDS } from '@/mocks/db';

/** A person's own language (#766): chosen on the account page, applied without signing out. */

const open = async (heading = 'Your account') => {
  const app = renderApp({ entry: '/profile' });
  await screen.findByRole('heading', { name: heading });
  return app;
};

describe('the language choice', () => {
  it('follows the hospital until the person chooses, then follows the person', async () => {
    await open();
    const select = await screen.findByLabelText('Language for your screens');
    expect(select).toHaveValue('');
    expect(document.documentElement.lang).toBe('en-IN');

    await userEvent.selectOptions(select, 'hi');

    await waitFor(() => expect(document.documentElement.lang).toBe('hi'));
    expect(await screen.findByLabelText('आपकी स्क्रीन की भाषा')).toHaveValue('hi');
    expect(await screen.findByText('भाषा सहेज ली गई।')).toBeInTheDocument();
  });

  it('goes back to the hospital default when cleared', async () => {
    setMockLanguage(USER_IDS.admin, 'hi');
    await open('आपका खाता');
    const select = await screen.findByLabelText('आपकी स्क्रीन की भाषा');
    expect(select).toHaveValue('hi');

    await userEvent.selectOptions(select, '');

    await waitFor(() => expect(document.documentElement.lang).toBe('en-IN'));
  });

  it('leaves another user of the same hospital unaffected', async () => {
    setMockLanguage(USER_IDS.doctor, 'hi');
    await open();
    expect(await screen.findByLabelText('Language for your screens')).toHaveValue('');
  });

  it('lets a person use English in a hospital whose locale is Hindi', async () => {
    setTenantLocale(TENANT_IDS.hospital, 'hi-IN');
    setMockLanguage(USER_IDS.admin, 'en');
    await open();
    await screen.findByLabelText('Language for your screens');
    expect(document.documentElement.lang).toBe('en');
  });
});
