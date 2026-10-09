import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Root providers. F-01 adds the Redux store, i18n, session, tenant and access policy providers here.
 */
export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
