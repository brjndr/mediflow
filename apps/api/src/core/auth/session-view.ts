import { Type, type Static } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from '../db/schema.js';
import { ref, StringEnum } from '../http/schemas.js';
import { Tenant, toTenant } from '../tenancy/routes.js';
import { isMfaEnabled } from './mfa.js';

export const Membership = Type.Object(
  {
    tenantId: Type.String(),
    /** So the hospital picker needs no second request. */
    tenantName: Type.String(),
    roleId: Type.String(),
  },
  { $id: 'Membership' },
);

export const User = Type.Object(
  {
    id: Type.String(),
    email: Type.String(),
    name: Type.String(),
    memberships: Type.Array(ref(Membership)),
    mfaEnabled: Type.Boolean({ description: 'Whether sign-in asks for an authenticator code.' }),
  },
  { $id: 'User' },
);

export const PermissionGrant = Type.Object(
  {
    permission: Type.String({ description: 'resource:action' }),
    scope: Type.Optional(StringEnum(['all', 'own', 'department'])),
  },
  { $id: 'PermissionGrant' },
);

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

/** What the web app loads once at start: who is signed in, where, and what they may do. */
export const Session = Type.Object(
  {
    user: ref(User),
    activeTenant: Type.Union([ref(Tenant), Type.Null()], {
      description: 'Null until a user with several hospitals picks one.',
    }),
    policy: Type.Union([ref(AccessPolicy), Type.Null()], {
      description:
        'Null when there is no active tenant. Also null until roles and permissions exist in the API (BE-05).',
    }),
  },
  { $id: 'Session' },
);
export type Session = Static<typeof Session>;

export const AUTH_SCHEMAS = [Membership, User, PermissionGrant, AccessPolicy, Session] as const;

/**
 * Builds the session response for an identified user. Runs as the auth role with the user set,
 * so the database itself limits what is visible to this user's memberships and the hospitals
 * they belong to.
 */
export async function loadSessionView(
  client: pg.PoolClient,
  userId: string,
  activeTenantId: string | null,
): Promise<Session> {
  const user = await client.query<{ id: string; email: string; name: string }>(
    'select id, email, name from users where id = $1',
    [userId],
  );
  const account = user.rows[0];
  if (!account) throw new Error('session user not found');

  const memberships = await client.query<{
    tenant_id: string;
    tenant_name: string;
    role_id: string;
  }>(
    `select m.tenant_id, t.name as tenant_name, m.role_id
     from memberships m join tenants t on t.id = m.tenant_id
     where m.user_id = $1 and m.status = 'active'
     order by t.name, m.tenant_id`,
    [userId],
  );

  let activeTenant: Session['activeTenant'] = null;
  if (activeTenantId) {
    const db = drizzle(client, { schema });
    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, activeTenantId));
    if (tenant) {
      const flags = await db
        .select()
        .from(schema.tenantFeatures)
        .where(eq(schema.tenantFeatures.tenantId, activeTenantId));
      activeTenant = toTenant(tenant, flags);
    }
  }

  return {
    user: {
      id: account.id,
      email: account.email,
      name: account.name,
      memberships: memberships.rows.map((row) => ({
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        roleId: row.role_id,
      })),
      mfaEnabled: await isMfaEnabled(client, userId),
    },
    activeTenant,
    // Roles and permissions arrive with BE-05.
    policy: null,
  };
}
