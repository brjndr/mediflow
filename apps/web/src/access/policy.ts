import type { AccessPolicy, Permission, PermissionScope } from '@/shared/types';

/**
 * Pure checks against the policy the backend sent. No policy, or no matching grant, is always
 * "no". The backend enforces the same rules: these only decide what the UI offers.
 */

/** The scope the user holds a permission with, or null when they do not hold it. */
export function permissionScope(
  policy: AccessPolicy | null,
  permission: Permission,
): PermissionScope | null {
  const grant = policy?.permissions.find((candidate) => candidate.permission === permission);
  if (!grant) return null;
  // A grant without a scope is unrestricted.
  return grant.scope ?? 'all';
}

export function hasPermission(policy: AccessPolicy | null, permission: Permission): boolean {
  return permissionScope(policy, permission) !== null;
}

export function isFeatureEnabled(policy: AccessPolicy | null, featureFlag: string): boolean {
  return policy?.features[featureFlag] === true;
}

export interface AccessRequirement {
  /** Every one of these permissions must be held. */
  requires?: Permission | readonly Permission[];
  /** The hospital must have this module switched on. */
  featureFlag?: string;
}

/** A feature or action is available only if the flag is on and every permission is held. */
export function isAllowed(policy: AccessPolicy | null, requirement: AccessRequirement): boolean {
  if (!policy) return false;
  const { requires = [], featureFlag } = requirement;
  if (featureFlag !== undefined && !isFeatureEnabled(policy, featureFlag)) return false;
  const permissions: readonly Permission[] = typeof requires === 'string' ? [requires] : requires;
  return permissions.every((permission) => hasPermission(policy, permission));
}
