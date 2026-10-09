import { createContext, useContext } from 'react';
import type { Tenant } from '@/shared/types';

/** Placeholder until F-05 binds the active tenant from the session. Null means no active tenant. */
export const TenantContext = createContext<Tenant | null>(null);

export function useTenant(): Tenant | null {
  return useContext(TenantContext);
}
