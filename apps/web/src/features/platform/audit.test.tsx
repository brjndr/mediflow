import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

function asPlatformAdmin() {
  setMockMfa(USER_IDS.platformAdmin, true);
  signIn(USER_IDS.platformAdmin);
}

describe('the platform audit trail', () => {
  it('lists the actions with the hospital named, and passes axe', async () => {
    asPlatformAdmin();
    renderApp({ entry: '/platform/audit' });

    expect(await screen.findByRole('heading', { name: 'Audit trail', level: 1 })).toBeVisible();
    const grid = await screen.findByRole('table', { name: 'Platform actions' });
    expect(await within(grid).findAllByText('Hospital created')).toHaveLength(2);
    expect(within(grid).getAllByText('City General Hospital').length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });

  it('narrows by hospital and by actor', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/audit' });
    const grid = await screen.findByRole('table', { name: 'Platform actions' });
    await within(grid).findAllByText('Hospital created');

    await user.selectOptions(
      screen.getByLabelText('Hospital', { selector: 'select' }),
      'Riverside Clinic',
    );
    expect(await within(grid).findByText('First admin invited')).toBeVisible();
    await waitFor(() => expect(within(grid).queryByText('Module switched on')).toBeNull());

    await user.selectOptions(
      screen.getByLabelText('Hospital', { selector: 'select' }),
      'All hospitals',
    );
    await user.type(screen.getByLabelText('Actor id'), 'user_platform_two');
    expect(await within(grid).findByText('Module switched on')).toBeVisible();
    await waitFor(() => expect(within(grid).queryByText('First admin invited')).toBeNull(), {
      timeout: 4000,
    });
  });

  it('says so when the actor is not an id', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/audit' });
    await user.type(await screen.findByLabelText('Actor id'), 'a b');
    expect(screen.getByText('That is not an id.')).toBeVisible();
    expect(screen.getByLabelText('Actor id')).toHaveAttribute('aria-invalid', 'true');
  });

  it('is not open to anyone but a platform admin', async () => {
    renderApp({ entry: '/platform/audit' });
    expect(screen.queryByRole('heading', { name: 'Audit trail' })).toBeNull();
  });
});
