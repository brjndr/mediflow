import { Type, type Static } from '@sinclair/typebox';
import { ref, StringEnum } from '../http/schemas.js';
import type { PermissionScope } from './registry.js';

export const PermissionGrant = Type.Object(
  {
    permission: Type.String({ description: 'resource:action' }),
    scope: Type.Optional(StringEnum(['all', 'own', 'department'])),
  },
  { $id: 'PermissionGrant' },
);

/** What one user may do at one hospital: their role's permissions and the hospital's modules. */
export const AccessPolicy = Type.Object(
  {
    tenantId: Type.String(),
    roleId: Type.String(),
    permissions: Type.Array(ref(PermissionGrant)),
    features: Type.Unsafe<Record<string, boolean>>({
      type: 'object',
      additionalProperties: { type: 'boolean' },
    }),
    version: Type.String(),
  },
  { $id: 'AccessPolicy' },
);
export type AccessPolicy = Static<typeof AccessPolicy>;

export const ACCESS_SCHEMAS = [PermissionGrant, AccessPolicy] as const;

/** Anything that can run one parameterised query: a pg client or pool. */
export interface Queryable {
  query<Row extends object>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
}

interface PolicyRow {
  role_id: string;
  policy_revision: string;
  permissions: { permission: string; scope: PermissionScope }[];
  features: Record<string, boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The effective policy of a user at a hospital, or null when they are not an active member.
 *
 * Reads through whatever connection it is given, so row-level security decides what is visible:
 * in a hospital's transaction that is the hospital's own roles; in an auth transaction, those of
 * the hospitals the identified user belongs to. Either way another hospital's grants cannot be
 * returned, whatever ids are passed.
 */
export async function loadPolicy(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<AccessPolicy | null> {
  if (!UUID.test(tenantId) || !UUID.test(userId)) return null;
  const { rows } = await db.query<PolicyRow>(
    `select m.role_id, t.policy_revision,
            coalesce((
              select json_agg(json_build_object('permission', p.permission, 'scope', p.scope) order by p.permission)
              from role_permissions p where p.tenant_id = m.tenant_id and p.role_id = m.role_id
            ), '[]'::json) as permissions,
            coalesce((
              select json_object_agg(f.feature, f.enabled)
              from tenant_features f where f.tenant_id = m.tenant_id
            ), '{}'::json) as features
     from memberships m join tenants t on t.id = m.tenant_id
     where m.tenant_id = $1 and m.user_id = $2 and m.status = 'active'`,
    [tenantId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tenantId,
    roleId: row.role_id,
    permissions: row.permissions,
    features: row.features,
    // The role is part of it, so moving a user to another role changes their version too.
    version: `${tenantId}.${row.role_id}.${row.policy_revision}`,
  };
}
