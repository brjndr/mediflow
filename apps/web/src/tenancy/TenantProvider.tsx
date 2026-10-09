import type { ReactNode } from 'react';
import type { Tenant } from '@/shared/types';
import { TenantContext } from './tenant-context';

export function TenantProvider({
  tenant = null,
  children,
}: {
  tenant?: Tenant | null;
  children: ReactNode;
}) {
  return <TenantContext.Provider value={tenant}>{children}</TenantContext.Provider>;
}
