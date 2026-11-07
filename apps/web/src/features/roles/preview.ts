import { isAllowed, permissionScope } from '@/access';
import type { NavItem, RegisteredRoute, Registry } from '@/registry';
import type { AccessPolicy, Permission, PermissionScope } from '@/shared/types';
import type { Grants } from './matrix';

/**
 * The policy a person in the role would get: the hospital's own module switches (the real
 * policy's) with the permissions replaced by the role's. A new object; the real policy is only
 * read, never changed.
 */
export function previewPolicy(real: AccessPolicy, grants: Grants): AccessPolicy {
  return {
    ...real,
    permissions: [...grants].map(([permission, scope]) => ({
      permission: permission as Permission,
      scope,
    })),
  };
}

export interface FeatureActions {
  featureId: string;
  titleKey: string;
  /** Every permission the module declares, and the scope it would be held at (null: not held). */
  actions: { permission: string; scope: PermissionScope | null }[];
}

export interface RolePreview {
  nav: NavItem[];
  pages: RegisteredRoute[];
  actions: FeatureActions[];
}

/**
 * What the role would see and be able to do. It asks the registry and the access evaluator the
 * running app asks (`navItems`, `isAllowed`, `permissionScope`), so it cannot drift from them.
 */
export function previewRole(registry: Registry, policy: AccessPolicy): RolePreview {
  return {
    nav: registry.navItems(policy),
    pages: registry.routes.filter((route) =>
      isAllowed(policy, { requires: route.requires, featureFlag: route.featureFlag }),
    ),
    actions: registry.enabledFeatures(policy).flatMap((feature) =>
      feature.permissions.length === 0
        ? []
        : [
            {
              featureId: feature.id,
              titleKey: feature.i18n
                ? `features:${feature.id}.${feature.titleKey}`
                : feature.titleKey,
              actions: feature.permissions.map((permission) => ({
                permission,
                scope: permissionScope(policy, permission),
              })),
            },
          ],
    ),
  };
}
