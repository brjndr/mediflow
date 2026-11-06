import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setMockMfa, signIn, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { slugFrom } from './schemas';

function asPlatformAdmin() {
  setMockMfa(USER_IDS.platformAdmin, true);
  signIn(USER_IDS.platformAdmin);
}

async function fillIdentity(user: ReturnType<typeof userEvent.setup>, name: string, slug?: string) {
  await user.type(await screen.findByLabelText(/Hospital name/), name);
  if (slug !== undefined) {
    const field = screen.getByLabelText(/^Slug/);
    await user.clear(field);
    await user.type(field, slug);
  }
}

async function fillLocale(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Locale/), 'en-IN');
  await user.type(screen.getByLabelText(/Time zone/), 'Asia/Kolkata');
  await user.selectOptions(screen.getByLabelText(/^Currency/), 'INR');
}

describe('slugFrom', () => {
  it('makes a slug from a name', () => {
    expect(slugFrom('  Saint Mary’s Hospital & Care  ')).toBe('saint-mary-s-hospital-care');
    expect(slugFrom('Café Clinic')).toBe('cafe-clinic');
    expect(slugFrom('!!!')).toBe('');
  });
});

describe('hospitals (platform)', () => {
  it('lists the hospitals', async () => {
    asPlatformAdmin();
    renderApp({ entry: '/platform/hospitals' });

    expect(await screen.findByRole('heading', { name: 'Hospitals', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('City General Hospital')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 hospitals');
    await expectNoAxeViolations();
  });

  it('creates a hospital in three steps and shows it in the list', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/new' });

    await fillIdentity(user, 'Lakeview Hospital');
    // The slug is suggested from the name.
    expect(screen.getByLabelText(/^Slug/)).toHaveValue('lakeview-hospital');
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('heading', { name: 'Language, clock and look' })).toHaveFocus();
    // A preview of the brand colour.
    expect(screen.getByText('Preview')).toBeInTheDocument();
    await fillLocale(user);
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('heading', { name: 'Modules and limits' })).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: 'Patients' }));
    expect(screen.getByRole('heading', { name: 'Check before creating' })).toBeInTheDocument();
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Create hospital' }));

    expect(await screen.findByText('Hospital Lakeview Hospital was created.')).toBeInTheDocument();
    expect(await screen.findByText('lakeview-hospital')).toBeInTheDocument();
  });

  it('checks a step before going on', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/new' });

    await screen.findByLabelText(/Hospital name/);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findAllByText('This field is required.')).not.toHaveLength(0);
    expect(screen.getByLabelText(/Hospital name/)).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Who the hospital is' })).toBeInTheDocument();
  });

  it('refuses a colour that is too light, a bad zone and a bad logo address', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/new' });

    await fillIdentity(user, 'Lakeview Hospital');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Language, clock and look' });

    const colour = screen.getByLabelText(/Brand colour/);
    await user.clear(colour);
    await user.type(colour, '#ffff99');
    const zone = screen.getByLabelText(/Time zone/);
    await user.clear(zone);
    await user.type(zone, 'Mars/Base');
    await user.type(screen.getByLabelText(/Logo address/), 'http://example.test/logo.png');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText(/too light to read/)).toBeInTheDocument();
    expect(screen.getByText('This is not a known time zone.')).toBeInTheDocument();
    expect(screen.getByText('Use an address that starts with https://.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Language, clock and look' })).toBeInTheDocument();
  });

  it('goes back to the slug when it is taken', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/new' });

    await fillIdentity(user, 'Another Hospital', 'city-general');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Language, clock and look' });
    await fillLocale(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Modules and limits' });
    await user.click(screen.getByRole('button', { name: 'Create hospital' }));

    expect(
      await screen.findByText('A hospital already has this slug. Choose another.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Who the hospital is' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Slug/)).toHaveFocus());
  });

  it('does not create when Enter is pressed before the last step', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/new' });

    await fillIdentity(user, 'Early Enter Hospital');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('heading', { name: 'Language, clock and look' }),
    ).toBeInTheDocument();
  });

  it('keeps what was typed when going back', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/new' });

    await fillIdentity(user, 'Lakeview Hospital');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Language, clock and look' });
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(await screen.findByLabelText(/Hospital name/)).toHaveValue('Lakeview Hospital');
  });

  it('shows the list with a link to the wizard, and the wizard is reachable by it', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals' });

    await user.click(await screen.findByRole('link', { name: 'New hospital' }));
    expect(
      await screen.findByRole('heading', { name: 'New hospital', level: 1 }),
    ).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getByText(/1\. Who the hospital is/)).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('does not leave focus on the step heading when the wizard opens', async () => {
    asPlatformAdmin();
    renderApp({ entry: '/platform/hospitals/new' });

    await screen.findByLabelText(/Hospital name/);
    expect(screen.getByRole('heading', { name: 'Who the hospital is' })).not.toHaveFocus();
  });

  it('is not stopped on an earlier step by a bad value left on a later one', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/new' });

    await fillIdentity(user, 'Lakeview Hospital');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Language, clock and look' });
    await user.type(screen.getByLabelText(/^Locale/), 'en-IN');
    await user.selectOptions(screen.getByLabelText(/^Currency/), 'INR');
    const zone = screen.getByLabelText(/Time zone/);
    await user.type(zone, 'Mars/Base');
    // Back never blocks, and Next on the first step checks the first step only.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      await screen.findByRole('heading', { name: 'Language, clock and look' }),
    ).toBeInTheDocument();

    // The bad value is named when its own step is left.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('This is not a known time zone.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Time zone/)).toHaveFocus());
  });

  it('filters the list by status', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals' });

    await screen.findByText('City General Hospital');
    await user.selectOptions(screen.getByLabelText('Show'), 'Suspended');

    expect(await screen.findByText('No hospitals yet.')).toBeInTheDocument();
    expect(screen.queryByText('City General Hospital')).not.toBeInTheDocument();
  });

  it.each([
    ['a hospital admin', USER_IDS.admin],
    ['a doctor', USER_IDS.doctor],
  ])('gives %s no access to the screens', async (_name, userId) => {
    signIn(userId);
    renderApp({ entry: '/platform/hospitals/new' });

    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Hospital name/)).not.toBeInTheDocument();
  });
});
