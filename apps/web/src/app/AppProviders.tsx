import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { i18n } from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { Provider as StoreProvider } from 'react-redux';
import { AccessPolicyProvider } from '@/access';
import { RegistryProvider, type Registry } from '@/registry';
import { TenantProvider } from '@/tenancy';
import { GlobalErrorBoundary } from './GlobalErrorBoundary';
import { SessionProvider, useSession } from './session';
import type { AppStore } from './store';

interface AppProvidersProps {
  client: QueryClient;
  store: AppStore;
  i18n: i18n;
  registry: Registry;
  children: ReactNode;
}

/** Tenant and policy come from the session but live in their own contexts (see AppProviders). */
function SessionScopedProviders({ children }: { children: ReactNode }) {
  const session = useSession();
  return (
    <TenantProvider tenant={session?.activeTenant ?? null}>
      <AccessPolicyProvider policy={session?.policy ?? null}>{children}</AccessPolicyProvider>
    </TenantProvider>
  );
}

/**
 * Root providers. Session, tenant and access policy are separate contexts so a change in one does
 * not re-render consumers of the others.
 */
export function AppProviders({ client, store, i18n, registry, children }: AppProvidersProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <GlobalErrorBoundary>
        <StoreProvider store={store}>
          <QueryClientProvider client={client}>
            <SessionProvider>
              <SessionScopedProviders>
                <RegistryProvider registry={registry}>{children}</RegistryProvider>
              </SessionScopedProviders>
            </SessionProvider>
          </QueryClientProvider>
        </StoreProvider>
      </GlobalErrorBoundary>
    </I18nextProvider>
  );
}
