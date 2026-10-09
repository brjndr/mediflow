import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  setTenantStatus,
  signIn,
  signOut,
  switchTenant as switchMockTenant,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOME = { name: 'Hospital management system' };
const home = () => screen.findByRole('heading', HOME);
const sidebar = () => screen.getByRole('navigation', { name: 'Main navigation' });
const linkNames = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent);

describe('shell', () => {
  it('has the landmarks, the sidebar from the registry and the signed-in user', async () => {
    renderApp();
    await home();
    expect(linkNames(sidebar())).toEqual(['Home', 'Notices']);
    expect(within(sidebar()).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const header = screen.getByRole('banner');
    expect(header).toHaveTextContent('Sample Hospital');
    expect(header).toHaveTextContent('Sample Admin');
    expect(header).toHaveTextContent('admin@sample-hospital.test');
    expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', HOME));
  });

  it('collapses the sidebar to icons and keeps every link named', async () => {
    const { store } = renderApp();
    await home();
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(toggle);

    expect(store.getState().ui.sidebarCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Names are still exposed to assistive technology, and as a tooltip for mouse users.
    expect(linkNames(sidebar())).toEqual(['Home', 'Notices']);
    expect(within(sidebar()).getByRole('link', { name: 'Notices' })).toHaveAttribute(
      'title',
      'Notices',
    );
    await expectNoAxeViolations();
  });

  it('moves focus to the main content after a navigation', async () => {
    renderApp();
    await home();
    await userEvent.click(within(sidebar()).getByRole('link', { name: 'Notices' }));
    await screen.findByRole('heading', { name: 'Staff notices' });
    expect(screen.getByRole('main')).toHaveFocus();
  });
});

describe('keyboard', () => {
  it('reaches the skip link first, then the navigation, in a sensible order', async () => {
    renderApp();
    await home();
    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');

    await userEvent.tab();
    expect(within(sidebar()).getByRole('link', { name: 'Home' })).toHaveFocus();
    await userEvent.tab();
    expect(within(sidebar()).getByRole('link', { name: 'Notices' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
  });

  it('follows a nav link with Enter', async () => {
    const { router } = renderApp();
    await home();
    within(sidebar()).getByRole('link', { name: 'Notices' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Staff notices' });
    expect(router.state.location.pathname).toBe('/notices');
  });

  it('toggles the sidebar with the keyboard', async () => {
    const { store } = renderApp();
    await home();
    screen.getByRole('button', { name: 'Collapse sidebar' }).focus();
    await userEvent.keyboard(' ');
    expect(store.getState().ui.sidebarCollapsed).toBe(true);
    await userEvent.keyboard('{Enter}');
    expect(store.getState().ui.sidebarCollapsed).toBe(false);
  });
});

describe('navigation drawer (narrow screens)', () => {
  const drawer = () => screen.getByRole<HTMLDialogElement>('dialog', { name: 'Menu' });

  it('opens as a modal dialog with the same navigation and closes when a link is followed', async () => {
    const { router } = renderApp();
    await home();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(drawer()).toHaveAttribute('open');
    expect(linkNames(within(drawer()).getByRole('navigation'))).toEqual(['Home', 'Notices']);
    await expectNoAxeViolations(drawer());

    await userEvent.click(within(drawer()).getByRole('link', { name: 'Notices' }));
    await screen.findByRole('heading', { name: 'Staff notices' });
    expect(router.state.location.pathname).toBe('/notices');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes from its close button', async () => {
    renderApp();
    await home();
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    await userEvent.click(within(drawer()).getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the browser closes the dialog (Escape)', async () => {
    renderApp();
    await home();
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    // Escape on a modal <dialog> is handled by the browser, which fires `close`. jsdom does not
    // implement that key handling, so the event the browser would fire is dispatched here.
    drawer().close();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // It can be opened again afterwards.
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(drawer()).toHaveAttribute('open');
  });
});

describe('system pages', () => {
  it('shows a not-found page inside the shell for an unknown address', async () => {
    const { router } = renderApp({ entry: '/no/such/page' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(linkNames(sidebar())).toEqual(['Home', 'Notices']);
    await expectNoAxeViolations();

    await userEvent.click(screen.getByRole('link', { name: 'Back to home' }));
    await home();
    expect(router.state.location.pathname).toBe('/');
  });

  it('sends a signed-out user to login, not to the not-found page', async () => {
    signOut();
    renderApp({ entry: '/no/such/page' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('shows the no-access page with a way back', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/notices' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
    await expectNoAxeViolations();
  });

  it('passes axe on the shell, the notices page and the hospital picker', async () => {
    const app = renderApp();
    await home();
    await expectNoAxeViolations();

    await app.router.navigate('/notices');
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(25));
    await expectNoAxeViolations();
    app.unmount();

    signIn(USER_IDS.doctor);
    renderApp();
    await screen.findByRole('heading', { name: 'Choose a hospital' });
    await expectNoAxeViolations();
  });
});

describe('suspended hospital', () => {
  const SUSPENDED = { name: 'Sample Hospital is suspended' };

  it('replaces the whole app, whatever the address', async () => {
    setTenantStatus(TENANT_IDS.hospital, 'suspended');
    renderApp({ entry: '/notices' });
    expect(await screen.findByRole('heading', SUSPENDED)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Staff notices' })).not.toBeInTheDocument();
    // A user with one hospital has nowhere to switch to.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('lets a user who also works elsewhere switch to the other hospital', async () => {
    setTenantStatus(TENANT_IDS.hospital, 'suspended');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp();
    await screen.findByRole('heading', SUSPENDED);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );

    await home();
    expect(screen.getByRole('banner')).toHaveTextContent('Sample Doctor');
    expect(screen.queryByRole('heading', SUSPENDED)).not.toBeInTheDocument();
  });

  it('takes over an open tab when the hospital is suspended mid-session', async () => {
    renderApp({ entry: '/notices' });
    await screen.findByRole('heading', { name: 'Staff notices' });

    // A platform admin suspends the hospital; this tab learns of it from its next request.
    setTenantStatus(TENANT_IDS.hospital, 'suspended');
    await expect(api.GET('/notices')).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'tenant_suspended',
    });

    expect(await screen.findByRole('heading', SUSPENDED)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('does not affect the user’s other hospital', async () => {
    setTenantStatus(TENANT_IDS.hospital, 'suspended');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    switchMockTenant(TENANT_IDS.clinic);
    renderApp();
    await home();
    expect(screen.getByRole('combobox', { name: 'Hospital' })).toHaveValue(TENANT_IDS.clinic);
  });
});
