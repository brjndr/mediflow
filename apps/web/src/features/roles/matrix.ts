import type { PermissionScope } from '@/shared/types';
import type { RoleGrant } from './types';

/** What a role holds as it is edited: the permission and the scope it is held at. */
export type Grants = ReadonlyMap<string, PermissionScope>;

/** The permission the server will not let a caller take from their own role. */
export const OWN_ACCESS = 'role:manage';

export function toGrants(list: readonly RoleGrant[]): Grants {
  return new Map(list.map((grant) => [grant.permission, grant.scope ?? 'all']));
}

export function toList(grants: Grants): RoleGrant[] {
  return [...grants].map(([permission, scope]) => ({ permission, scope }));
}

/** Permissions whose grant differs between two sets (added, removed or at another scope). */
export function differences(a: Grants, b: Grants): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((key) => a.get(key) !== b.get(key));
}

/**
 * The edit put over what was saved since: the permissions the person touched keep their value
 * from `draft`, every other one is as `latest` has it.
 */
export function rebase(latest: Grants, draft: Grants, changed: readonly string[]): Grants {
  const next = new Map(latest);
  for (const permission of changed) {
    const scope = draft.get(permission);
    if (scope === undefined) next.delete(permission);
    else next.set(permission, scope);
  }
  return next;
}

/** Whether a scope held reaches as far as the one wanted. */
export function withinHeld(held: PermissionScope | undefined, wanted: PermissionScope): boolean {
  return held !== undefined && (held === 'all' || held === wanted);
}
