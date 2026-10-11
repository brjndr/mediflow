import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  setRolePermissions,
  setTenantFeature,
  signIn,
  signOut,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { appRegistry } from '@/registry';
import { renderApp } from '@/test/render';

/**
 * Every screen a feature registers is behind the same guards, whatever the feature. These run
 * over the app's real registry, so a route added tomorrow is covered without touching this file.
 */

/** A concrete address for a route pattern: `patients/:id` becomes `/patients/x`. */
const addressOf = (path: string) => `/${path.replace(/:[^/]+/g, 'x')}`;
const routes = appRegistry.routes.map((route) => ({ ...route, address: addressOf(route.path) }));
const addresses = routes.map((route) => route.address);
/** Routes that need a permission. A few (the dev examples) need only their module to be on. */
const permissioned = routes.filter((route) => route.requires.length > 0);
const NO_ACCESS = { name: 'You do not have access to this page' };

/** The app's own bootstrap questions, asked for every signed-in user whatever the screen. */
const isBootstrap = (path: string) =>
  path.startsWith('/api/session') || path === '/api/auth/mfa/requirement';

function watchRequests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(new URL(request.url).pathname);
  });
  return seen;
}

describe('every registered route', () => {
  it('exists', () => {
    expect(addresses.length).toBeGreaterThan(0);
  });

  it.each(addresses)(
    '%s sends a signed-out visitor to login, remembering the address',
    async (address) => {
      signOut();

      const { router } = renderApp({ entry: address });

      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
      expect(router.state.location).toMatchObject({ pathname: '/login', state: { from: address } });
    },
  );

  it.each(permissioned.map((route) => route.address))(
    '%s is closed to a role with no permissions, and loads nothing',
    async (address) => {
      setRolePermissions(TENANT_IDS.hospital, 'admin', []);
      signIn(USER_IDS.admin);
      const requests = watchRequests();

      renderApp({ entry: address });

      expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
      // Only the session bootstrap and the policy: the screen's own data was never asked for.
      expect(requests.filter((path) => !isBootstrap(path))).toEqual([]);
    },
  );

  it.each(routes.map((route) => [route.address, route.featureFlag] as const))(
    '%s is closed when the hospital has its module (%s) off, whatever the role holds',
    async (address, featureFlag) => {
      setTenantFeature(TENANT_IDS.hospital, featureFlag, false);
      signIn(USER_IDS.admin);
      const requests = watchRequests();

      renderApp({ entry: address });

      expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
      expect(requests.filter((path) => !isBootstrap(path))).toEqual([]);
    },
  );

  it.each(addresses)(
    '%s asks someone with no active hospital to pick one first',
    async (address) => {
      signIn(USER_IDS.doctor);

      renderApp({ entry: address });

      expect(await screen.findByRole('heading', { name: 'Choose a hospital' })).toBeInTheDocument();
    },
  );
});

describe('an address no feature registered', () => {
  it('is a not-found page inside the app for a signed-in user, and login for anyone else', async () => {
    signIn(USER_IDS.admin);
    const signedIn = renderApp({ entry: '/no/such/screen' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    signedIn.unmount();

    signOut();
    renderApp({ entry: '/no/such/screen' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
