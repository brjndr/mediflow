import { QueryClient } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { Suspense, type ReactElement, type ReactNode } from 'react';
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  type RouteObject,
} from 'react-router-dom';
import { AppProviders } from '@/app/AppProviders';
import { createI18n, type CoreLocales } from '@/app/i18n';
import { sessionKey, type Session } from '@/app/session';
import { createStore, type AppStore } from '@/app/store';
import { appRegistry, type Registry } from '@/registry';
import { createRoutes } from '@/routes';

interface SharedOptions {
  queryClient?: QueryClient;
  store?: AppStore;
  /** Seeds the session instead of loading it from the mock API. Null renders signed out. */
  session?: Session | null;
  /** Feature manifests to run with. Defaults to the app's own registry. */
  registry?: Registry;
  /** Core locale files to run with, to add a language. Defaults to the app's own. */
  coreLocales?: CoreLocales;
}

interface Options extends SharedOptions, Omit<RenderOptions, 'wrapper'> {
  route?: string;
}

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

/**
 * Translation keys that had no text in any language during the current test. The test setup
 * fails a test that leaves any here, so a typo in a key or a string missing from the English
 * file cannot pass unnoticed.
 */
export const missingTranslationKeys: string[] = [];

/** A fresh instance per render, so the language of one test never leaks into the next. */
function createTestI18n(registry: Registry, coreLocales?: CoreLocales) {
  return createI18n({
    features: registry.translations,
    coreLocales,
    onMissingKey: (key) => missingTranslationKeys.push(key),
  });
}

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
    coreLocales,
    ...rest
  } = options;
  if (session !== undefined) queryClient.setQueryData(sessionKey, session);
  const i18n = createTestI18n(registry, coreLocales);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders client={queryClient} store={store} i18n={i18n} registry={registry}>
        <MemoryRouter initialEntries={[route]}>
          {/* A feature screen suspends while its translations load, as it does under a route. */}
          <Suspense fallback={null}>{children}</Suspense>
        </MemoryRouter>
      </AppProviders>
    );
  }
  return { queryClient, store, ...render(ui, { wrapper: Wrapper, ...rest }) };
}

type InitialEntry = string | { pathname: string; search?: string; state?: unknown };

interface AppOptions extends SharedOptions {
  entry?: InitialEntry;
  /** Replaces the generated routes entirely. */
  routes?: RouteObject[];
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
    coreLocales,
  } = options;
  if (session !== undefined) queryClient.setQueryData(sessionKey, session);
  const router = createMemoryRouter(routes, { initialEntries: [entry] });
  const result = render(
    <AppProviders
      client={queryClient}
      store={store}
      i18n={createTestI18n(registry, coreLocales)}
      registry={registry}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { queryClient, store, router, ...result };
}
