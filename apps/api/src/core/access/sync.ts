import type pg from 'pg';
import type { PermissionDefinition } from './registry.js';

/**
 * Gives built-in roles the default grants they have not been offered yet, for one hospital or
 * for all of them.
 *
 * A default is applied once per hospital, role and permission, and remembered. So running this
 * again does nothing; a grant an admin has since removed stays removed; and when a new feature
 * declares a permission, the next run delivers its defaults to every hospital. Custom roles are
 * never touched.
 *
 * Runs on the owner connection (a deploy step, onboarding, the dev seed, tests), never in a
 * request. Returns how many grants were added.
 */
export async function syncRoleDefaults(
  db: pg.Pool | pg.ClientBase,
  definitions: readonly PermissionDefinition[],
  tenantId?: string,
): Promise<number> {
  const roles: string[] = [];
  const permissions: string[] = [];
  const scopes: string[] = [];
  for (const definition of definitions) {
    for (const [role, scope] of Object.entries(definition.defaults ?? {})) {
      roles.push(role);
      permissions.push(definition.id);
      scopes.push(scope);
    }
  }
  if (roles.length === 0) return 0;

  const { rowCount } = await db.query(
    `with defaults as (
       select * from unnest($1::text[], $2::text[], $3::text[]) as d (role_id, permission, scope)
     ),
     offered as (
       insert into role_default_grants (tenant_id, role_id, permission)
       select r.tenant_id, r.id, d.permission
       from roles r join defaults d on d.role_id = r.id
       where r.built_in and ($4::uuid is null or r.tenant_id = $4)
       on conflict do nothing
       returning tenant_id, role_id, permission
     )
     insert into role_permissions (tenant_id, role_id, permission, scope)
     select o.tenant_id, o.role_id, o.permission, d.scope
     from offered o join defaults d on d.role_id = o.role_id and d.permission = o.permission
     on conflict do nothing`,
    [roles, permissions, scopes, tenantId ?? null],
  );
  return rowCount ?? 0;
}
