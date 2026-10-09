import { createContext, useContext } from 'react';
import type { AccessPolicy } from '@/shared/types';

/**
 * Placeholder until F-07 adds usePermission, <Can> and PermissionGuard on top of the policy from
 * the backend. Null means no policy is loaded, which must be treated as no access.
 */
export const AccessPolicyContext = createContext<AccessPolicy | null>(null);

export function useAccessPolicy(): AccessPolicy | null {
  return useContext(AccessPolicyContext);
}
