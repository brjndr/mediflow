import { Type, type Static } from '@sinclair/typebox';
import { ErrorBody } from '../../core/http/errors.js';
import { ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

export const ROLE_NAME_MAX = 80;
export const MAX_GRANTS = 500;

export const RoleGrant = Type.Object(
  {
    permission: Type.String({ minLength: 3, maxLength: 127 }),
    scope: Type.Optional(StringEnum(['all', 'own', 'department'])),
  },
  { $id: 'RoleGrant', description: 'A permission and the scope it is held at (default all).' },
);

const Version = Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' });

export const RoleSummary = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    builtIn: Type.Boolean(),
    permissionCount: Type.Integer(),
    memberCount: Type.Integer({ description: 'Active members in the role' }),
    version: Version,
  },
  { $id: 'RoleSummary' },
);

export const RoleList = Type.Object({ items: Type.Array(ref(RoleSummary)) }, { $id: 'RoleList' });

export const RoleDetail = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    builtIn: Type.Boolean(),
    memberCount: Type.Integer(),
    permissions: Type.Array(ref(RoleGrant)),
    updatedAt: Type.String(),
    version: Version,
  },
  { $id: 'RoleDetail' },
);

export const PermissionCatalog = Type.Object(
  {
    items: Type.Array(
      Type.Object({
        permission: Type.String(),
        description: Type.String(),
        feature: Type.String(),
        scopes: Type.Array(StringEnum(['all', 'own', 'department']), {
          description: 'The scopes the permission can be held at; always starts with all',
        }),
      }),
    ),
  },
  { $id: 'PermissionCatalog', description: 'Every permission the API knows, for the role editor.' },
);

const Name = Type.String({ minLength: 1, maxLength: ROLE_NAME_MAX, pattern: PLAIN_TEXT });

export const CreateRoleBody = Type.Object({
  name: Name,
  permissions: Type.Array(ref(RoleGrant), { maxItems: MAX_GRANTS }),
});

/**
 * What a 409 of `PUT /roles/{roleId}` looks like: the standard error body, with the role as it is
 * now beside it when the code is version_conflict.
 */
export const RoleConflict = Type.Object(
  { error: ErrorBody.properties.error, current: Type.Optional(ref(RoleDetail)) },
  { $id: 'RoleConflict', description: 'Error body; `current` comes with version_conflict.' },
);

export const UpdateRoleBody = Type.Object({
  expectedVersion: Type.Integer({
    minimum: 1,
    description: 'The version of the role the change was made from',
  }),
  name: Type.Optional(Name),
  permissions: Type.Optional(Type.Array(ref(RoleGrant), { maxItems: MAX_GRANTS })),
});

export const ROLE_SCHEMAS = [
  RoleGrant,
  RoleSummary,
  RoleList,
  RoleDetail,
  PermissionCatalog,
  RoleConflict,
] as const;
export type RoleGrantInput = Static<typeof RoleGrant>;
