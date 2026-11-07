import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { grantsWithin } from '../../core/access/policy.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  deleteRole,
  findRole,
  grantsOf,
  holderCounts,
  insertRole,
  listRoles,
  lockManagers,
  lockRoleChanges,
  renameRole,
  replaceGrants,
  roleTaken,
  touchRole,
  usesOfRole,
  type Grant,
  type RoleRow,
} from './repository.js';
import {
  CreateRoleBody,
  PermissionCatalog,
  ROLE_NAME_MAX,
  ROLE_SCHEMAS,
  RoleDetail,
  RoleList,
  type RoleGrantInput,
  UpdateRoleBody,
} from './schemas.js';

const READ = 'role:read';
const MANAGE = 'role:manage';
/** Permissions that must never be left with no active holder in a hospital. */
const KEEP_HELD = [MANAGE, 'staff:manage'] as const;
const RESERVED_IDS = new Set(['platform_admin']);

const notFound = () => new HttpError(404, 'role_not_found', 'No such role');
const tooMuch = () => new HttpError(403, 'role_not_allowed', 'That role holds more than you do');
const taken = () => new HttpError(409, 'role_exists', 'A role with that name already exists');

/** `Nurse in charge` becomes `nurse_in_charge`; null when nothing usable is left. */
export function roleIdFrom(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/, '');
  if (slug === '') return null;
  return /^[a-z]/.test(slug) ? slug : `role_${slug}`;
}

const detail = (row: RoleRow, permissions: Grant[]) => ({
  id: row.id,
  name: row.name,
  builtIn: row.built_in,
  memberCount: row.member_count,
  permissions,
  updatedAt: row.updated_at.toISOString(),
});

export const roleRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of ROLE_SCHEMAS) app.addSchema(schema);
  const RoleParams = Type.Object({ roleId: Type.String({ minLength: 1, maxLength: 63 }) });

  /** Checks a requested set of grants and returns it with the scope filled in. */
  function checkGrants(wanted: readonly RoleGrantInput[]) {
    const seen = new Set<string>();
    return wanted.map(({ permission, scope }): Grant => {
      if (!app.permissions.has(permission)) {
        throw new HttpError(400, 'unknown_permission', 'A permission is not one this system knows');
      }
      if (seen.has(permission)) {
        throw new HttpError(400, 'duplicate_permission', 'A permission is listed twice');
      }
      seen.add(permission);
      return { permission, scope: scope ?? 'all' };
    });
  }

  /** Nobody hands on more than they hold: every set given must lie within the caller's policy. */
  async function ceiling(request: FastifyRequest, ...sets: readonly Grant[][]): Promise<void> {
    const policy = await request.access.policy();
    if (!policy) throw new HttpError(403, 'permission_denied', 'Not a member of this hospital');
    for (const set of sets) if (!grantsWithin(set, policy.permissions)) throw tooMuch();
  }

  /** Role changes of the hospital one after another, and its managers held in place. */
  async function beginChange(request: FastifyRequest): Promise<Map<string, number>> {
    await lockRoleChanges(request.txClient);
    await lockManagers(request.txClient, KEEP_HELD);
    return holderCounts(request.txClient, KEEP_HELD);
  }

  /** After a change: somebody still manages the hospital, and the caller keeps their own access. */
  async function endChange(
    request: FastifyRequest,
    before: Map<string, number>,
    editedRoleId: string | null,
  ): Promise<void> {
    if (editedRoleId !== null) {
      const userId = request.session?.userId ?? '';
      const inRole = await request.txClient.query(
        `select exists (select from memberships where user_id = $1 and role_id = $2) as member,
                exists (select from role_permissions where role_id = $2 and permission = $3) as holds`,
        [userId, editedRoleId, MANAGE],
      );
      const row = inRole.rows[0] as { member: boolean; holds: boolean } | undefined;
      if (row?.member && !row.holds) {
        throw new HttpError(
          409,
          'cannot_remove_own_access',
          'You cannot take away your own ability to manage roles',
        );
      }
    }
    const after = await holderCounts(request.txClient, KEEP_HELD);
    for (const id of KEEP_HELD) {
      if ((before.get(id) ?? 0) > 0 && (after.get(id) ?? 0) === 0) {
        throw new HttpError(409, 'last_admin', 'Nobody would be left to manage roles or staff');
      }
    }
  }

  app.get(
    '/roles',
    {
      config: { permissions: [READ] },
      schema: {
        operationId: 'listRoles',
        tags: ['roles'],
        description:
          "The active hospital's roles, built-in ones first, with how many permissions each holds and how many active members it has. A hospital has few roles, so the list is not paged.",
        response: { 200: ref(RoleList), ...errors(401, 403, 409, 429) },
      },
    },
    async (request) => ({
      items: (await listRoles(request.txClient)).map((row) => ({
        id: row.id,
        name: row.name,
        builtIn: row.built_in,
        permissionCount: row.permission_count,
        memberCount: row.member_count,
      })),
    }),
  );

  app.get(
    '/permission-catalog',
    {
      config: { permissions: [READ] },
      schema: {
        operationId: 'listPermissionCatalog',
        tags: ['roles'],
        description:
          'Every permission the API knows, with what holding it allows and the module that declares it, for the role editor. The same for every hospital.',
        response: { 200: ref(PermissionCatalog), ...errors(401, 403, 409, 429) },
      },
    },
    async () => ({
      items: app.permissions
        .all()
        .map(({ id, description, feature }) => ({ permission: id, description, feature }))
        .sort((a, b) => a.permission.localeCompare(b.permission)),
    }),
  );

  app.get(
    '/roles/:roleId',
    {
      config: { permissions: [READ] },
      schema: {
        operationId: 'getRole',
        tags: ['roles'],
        description:
          'One role of the active hospital with everything it may do. A role of another hospital answers 404 role_not_found, the same as one that does not exist.',
        params: RoleParams,
        response: { 200: ref(RoleDetail), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findRole(request.txClient, request.params.roleId);
      if (!row) throw notFound();
      return detail(row, await grantsOf(request.txClient, row.id));
    },
  );

  app.post(
    '/roles',
    {
      config: { permissions: [MANAGE], idempotent: { body: 'none' } },
      schema: {
        operationId: 'createRole',
        tags: ['roles'],
        headers: IdempotencyHeaders,
        description:
          'Creates a custom role. Its id is made from the name (`Nurse in charge` is `nurse_in_charge`); 409 role_exists when the id or the name is taken. 400 unknown_permission or duplicate_permission for a bad list. A role may hold nothing the caller does not hold, at a scope that is no wider: 403 role_not_allowed. Audited, and it moves the hospital policy version, so open sessions pick it up at their next refresh.',
        body: CreateRoleBody,
        response: { 201: ref(RoleDetail), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf) {
        // A repeat of a create that went through: answer with the role as it is now.
        const repeated = roleIdFrom(tidyWithin(request.body.name, ROLE_NAME_MAX));
        const row = repeated ? await findRole(request.txClient, repeated) : null;
        if (!row) throw notFound();
        return reply.status(201).send(detail(row, await grantsOf(request.txClient, row.id)));
      }
      const name = tidyWithin(request.body.name, ROLE_NAME_MAX);
      const id = roleIdFrom(name);
      if (id === null || RESERVED_IDS.has(id)) {
        throw new HttpError(400, 'validation_failed', 'The name must contain letters or digits');
      }
      const grants = checkGrants(request.body.permissions as RoleGrantInput[]);
      await ceiling(request, grants);
      await lockRoleChanges(request.txClient);
      if (await roleTaken(request.txClient, id, name)) throw taken();
      await insertRole(request.txClient, id, name);
      await replaceGrants(request.txClient, id, grants);
      request.audit('create', 'role', id);
      const row = await findRole(request.txClient, id);
      if (!row) throw notFound();
      return reply.status(201).send(detail(row, await grantsOf(request.txClient, id)));
    },
  );

  app.put(
    '/roles/:roleId',
    {
      config: { permissions: [MANAGE] },
      schema: {
        operationId: 'updateRole',
        tags: ['roles'],
        description:
          "Renames a custom role and/or replaces what a role may do (`permissions` is the whole new set). A built-in role keeps its id and name for good: sending another name answers 409 built_in_role; its permissions can be changed, and a default an admin removed is not put back by a deploy. Nobody acts above themselves: 403 role_not_allowed when the role holds now, or after the change would hold, more than the caller does. 409 last_admin when nobody active would be left holding role:manage or staff:manage; 409 cannot_remove_own_access when the caller's own role would lose role:manage. Audited; moves the policy version.",
        params: RoleParams,
        body: UpdateRoleBody,
        response: { 200: ref(RoleDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { roleId } = request.params;
      const grants = request.body.permissions
        ? checkGrants(request.body.permissions as RoleGrantInput[])
        : null;
      const name =
        request.body.name === undefined ? null : tidyWithin(request.body.name, ROLE_NAME_MAX);
      const before = await beginChange(request);
      const row = await findRole(request.txClient, roleId, true);
      if (!row) throw notFound();
      const renamed = name !== null && name !== row.name;
      if (renamed) {
        if (row.built_in) {
          throw new HttpError(409, 'built_in_role', 'A built-in role keeps its name');
        }
        if (await roleTaken(request.txClient, '', name, roleId)) throw taken();
      }
      // What the role holds now and what it is to hold: a role above the caller is not theirs to
      // change, and they cannot raise one above themselves.
      await ceiling(request, await grantsOf(request.txClient, roleId), grants ?? []);
      if (renamed) await renameRole(request.txClient, roleId, name);
      if (grants) {
        await replaceGrants(request.txClient, roleId, grants);
        await touchRole(request.txClient, roleId);
      }
      await endChange(request, before, roleId);
      request.audit('update', 'role', roleId);
      const updated = await findRole(request.txClient, roleId);
      if (!updated) throw notFound();
      return detail(updated, await grantsOf(request.txClient, roleId));
    },
  );

  app.delete(
    '/roles/:roleId',
    {
      config: { permissions: [MANAGE] },
      schema: {
        operationId: 'deleteRole',
        tags: ['roles'],
        description:
          'Deletes a custom role. 409 built_in_role for a built-in one, which can never be deleted; 409 role_in_use while any member (active or deactivated) or invitation names it. Nobody acts above themselves: 403 role_not_allowed for a role that holds more than the caller. Audited.',
        params: RoleParams,
        response: {
          204: Type.Null({ description: 'Deleted' }),
          ...errors(401, 403, 404, 409, 429),
        },
      },
    },
    async (request, reply) => {
      const { roleId } = request.params;
      const before = await beginChange(request);
      const row = await findRole(request.txClient, roleId, true);
      if (!row) throw notFound();
      if (row.built_in) {
        throw new HttpError(409, 'built_in_role', 'A built-in role cannot be deleted');
      }
      await ceiling(request, await grantsOf(request.txClient, roleId));
      if ((await usesOfRole(request.txClient, roleId)) > 0) {
        throw new HttpError(409, 'role_in_use', 'Members or invitations still have this role');
      }
      await deleteRole(request.txClient, roleId);
      await endChange(request, before, null);
      request.audit('delete', 'role', roleId);
      return reply.status(204).send(null);
    },
  );
};
