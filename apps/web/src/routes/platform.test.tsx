import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setMockMfa, signIn, signOut, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { appRegistry } from '@/registry';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const NO_ACCESS = { name: 'You do not have access to this page' };
const PLATFORM = { name: 'Platform administration', level: 1 };

function watchRequests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(new URL(request.url).pathname);
  });
  return seen;
}

describe('the platform area', () => {
  it('opens for a platform admin with an authenticator, in a shell of its own', async () => {
    setMockMfa(USER_IDS.platformAdmin, true);
    signIn(USER_IDS.platformAdmin);

    renderApp({ entry: '/platform' });

    expect(await screen.findByRole('heading', PLATFORM)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Platform navigation' })).toBeInTheDocument();
    // No hospital's navigation, switcher or picker.
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Patients' })).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('is where a platform admin lands, instead of a hospital picker', async () => {
    setMockMfa(USER_IDS.platformAdmin, true);
    signIn(USER_IDS.platformAdmin);

    const { router } = renderApp({ entry: '/' });

    expect(await screen.findByRole('heading', PLATFORM)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/platform');
  });

  it('reaches no hospital screen: every one of them sends a platform admin back', async () => {
    setMockMfa(USER_IDS.platformAdmin, true);
    signIn(USER_IDS.platformAdmin);
    const requests = watchRequests();

    const { router } = renderApp({ entry: '/patients' });

    expect(await screen.findByRole('heading', PLATFORM)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/platform');
    expect(requests.some((path) => path.includes('/patients'))).toBe(false);
  });

  it('takes a platform admin with no authenticator to the security screen only', async () => {
    setMockMfa(USER_IDS.platformAdmin, false);
    signIn(USER_IDS.platformAdmin);

    const { router } = renderApp({ entry: '/platform' });

    expect(await screen.findByRole('heading', { name: 'Security' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/platform/security');
  });

  it.each([
    ['a hospital admin', USER_IDS.admin],
    ['a doctor', USER_IDS.doctor],
    ['a receptionist', USER_IDS.receptionist],
  ])('answers %s with no access, and loads nothing of the area', async (_who, userId) => {
    signIn(userId);
    const requests = watchRequests();

    renderApp({ entry: '/platform' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('heading', PLATFORM)).not.toBeInTheDocument();
    expect(requests.filter((path) => path.startsWith('/api/platform'))).toEqual([]);
  });

  it('answers a signed-out visitor with the login page', async () => {
    signOut();
    renderApp({ entry: '/platform' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('is not in the hospital registry: no feature flag can switch it on for a hospital', () => {
    expect(appRegistry.routes.some((route) => route.path.startsWith('platform'))).toBe(false);
  });
});
