import { QueryClient } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '@/app/AppProviders';
import { createI18n } from '@/app/i18n';
import { createStore, type AppStore } from '@/app/store';

interface Options extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  queryClient?: QueryClient;
  store?: AppStore;
}

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

const i18n = createI18n();

/**
 * Render with the app's providers. As the foundation lands, this grows session, tenant and
 * access policy options (F-03, F-05, F-07) so tests can render as any user/hospital.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: Options = {},
): RenderResult & { queryClient: QueryClient; store: AppStore } {
  const {
    route = '/',
    queryClient = createTestQueryClient(),
    store = createStore(),
    ...rest
  } = options;
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders client={queryClient} store={store} i18n={i18n}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </AppProviders>
    );
  }
  return { queryClient, store, ...render(ui, { wrapper: Wrapper, ...rest }) };
}
