import { createContext, useContext } from 'react';
import type { AccessPolicy, Permission, PermissionScope } from '@/shared/types';
import {
  hasPermission,
  isAllowed,
  isFeatureEnabled,
  permissionScope,
  type AccessRequirement,
} from './policy';

/** The effective policy for the active hospital. Null means none is loaded: treat as no access. */
export const AccessPolicyContext = createContext<AccessPolicy | null>(null);

export function useAccessPolicy(): AccessPolicy | null {
  return useContext(AccessPolicyContext);
}

/** Whether the user holds a permission in the active hospital. Never compare role names instead. */
export function usePermission(permission: Permission): boolean {
  return hasPermission(useAccessPolicy(), permission);
}

/**
 * The scope a permission is held with ('all', 'own', 'department'), or null when it is not held.
 * Use it to word the UI ("My appointments"). The backend applies the scope to the data.
 */
export function usePermissionScope(permission: Permission): PermissionScope | null {
  return permissionScope(useAccessPolicy(), permission);
}

/** Whether the active hospital has a module switched on. */
export function useFeatureFlag(featureFlag: string): boolean {
  return isFeatureEnabled(useAccessPolicy(), featureFlag);
}

/** Combined check: the feature flag is on and every listed permission is held. */
export function useAllowed(requirement: AccessRequirement): boolean {
  return isAllowed(useAccessPolicy(), requirement);
}
