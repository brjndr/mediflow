import { QueryClient } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  type RouteObject,
} from 'react-router-dom';
import { AppProviders } from '@/app/AppProviders';
import { createI18n } from '@/app/i18n';
import { sessionKey, type Session } from '@/app/session';
import { createStore, type AppStore } from '@/app/store';
import { appRegistry, type Registry } from '@/registry';
import { createRoutes } from '@/routes';

interface Options extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  queryClient?: QueryClient;
  store?: AppStore;
  /** Seeds the session instead of loading it from the mock API. Null renders signed out. */
  session?: Session | null;
  /** Feature manifests to run with. Defaults to the app's own registry. */
  registry?: Registry;
}

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

/** Shared by every test render. Tests may add resource bundles for fixture features. */
export const i18n = createI18n();

/**
 * Render with the app's providers. Rendering is blocked until the session resolves, so query the
 * screen with findBy*. Pass `session` to render as a specific user and hospital.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: Options = {},
): RenderResult & { queryClient: QueryClient; store: AppStore } {
  const {
    route = '/',
    queryClient = createTestQueryClient(),
    store = createStore(),
    session,
    registry = appRegistry,
    ...rest
  } = options;
  if (session !== undefined) queryClient.setQueryData(sessionKey, session);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders client={queryClient} store={store} i18n={i18n} registry={registry}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </AppProviders>
    );
  }
  return { queryClient, store, ...render(ui, { wrapper: Wrapper, ...rest }) };
}

type InitialEntry = string | { pathname: string; search?: string; state?: unknown };

interface AppOptions {
  entry?: InitialEntry;
  /** Replaces the generated routes entirely. */
  routes?: RouteObject[];
  registry?: Registry;
  queryClient?: QueryClient;
  store?: AppStore;
  session?: Session | null;
}

interface AppResult extends RenderResult {
  queryClient: QueryClient;
  store: AppStore;
  router: ReturnType<typeof createMemoryRouter>;
}

/** Render the whole app (providers and the real routes) at a location, as main.tsx does. */
export function renderApp(options: AppOptions = {}): AppResult {
  const {
    entry = '/',
    registry = appRegistry,
    routes = createRoutes(registry),
    queryClient = createTestQueryClient(),
    store = createStore(),
    session,
  } = options;
  if (session !== undefined) queryClient.setQueryData(sessionKey, session);
  const router = createMemoryRouter(routes, { initialEntries: [entry] });
  const result = render(
    <AppProviders client={queryClient} store={store} i18n={i18n} registry={registry}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { queryClient, store, router, ...result };
}
