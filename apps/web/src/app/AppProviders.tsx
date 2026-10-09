import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { i18n } from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { Provider as StoreProvider } from 'react-redux';
import { AccessPolicyProvider } from '@/access';
import { TenantProvider } from '@/tenancy';
import { GlobalErrorBoundary } from './GlobalErrorBoundary';
import { SessionProvider } from './session';
import type { AppStore } from './store';

interface AppProvidersProps {
  client: QueryClient;
  store: AppStore;
  i18n: i18n;
  children: ReactNode;
}

/**
 * Root providers. Session, tenant and access policy are separate contexts so a change in one does
 * not re-render consumers of the others. They are placeholders until F-03, F-05 and F-07.
 */
export function AppProviders({ client, store, i18n, children }: AppProvidersProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <GlobalErrorBoundary>
        <StoreProvider store={store}>
          <QueryClientProvider client={client}>
            <SessionProvider>
              <TenantProvider>
                <AccessPolicyProvider>{children}</AccessPolicyProvider>
              </TenantProvider>
            </SessionProvider>
          </QueryClientProvider>
        </StoreProvider>
      </GlobalErrorBoundary>
    </I18nextProvider>
  );
}
