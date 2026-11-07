import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import {
  deleteMockRole,
  mockRoleGrants,
  mockRoleIds,
  onMockReset,
  setRolePermissions,
} from '../db';
import { authorize, error } from '../respond';
import { mockStaffOf } from './staff';

type RoleSummary = components['schemas']['RoleSummary'];
type RoleDetail = components['schemas']['RoleDetail'];
type RoleList = components['schemas']['RoleList'];
type PermissionCatalog = components['schemas']['PermissionCatalog'];
type Grants = Parameters<typeof setRolePermissions>[2];

const READ = 'role:read';
const MANAGE = 'role:manage';

/** The roles every hospital starts with. They keep their id and name for good. */
const BUILT_IN = new Set([
  'admin',
  'doctor',
  'nurse',
  'receptionist',
  'pharmacist',
  'lab_technician',
  'radiologist',
  'store_keeper',
]);

/** Names given to custom roles, by hospital. A built-in role's name comes from its id. */
let names = new Map<string, string>();
onMockReset(() => {
  names = new Map();
});

const nameKey = (tenantId: string, roleId: string) => `${tenantId}/${roleId}`;

/** A role's name as the hospital shows it. */
export function mockRoleName(tenantId: string, roleId: string): string {
  return (
    names.get(nameKey(tenantId, roleId)) ??
    roleId.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
  );
}

/** The id the API makes from a name: "Nurse in charge" is nurse_in_charge. */
const idFrom = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const notFound = () => error(404, 'role_not_found', 'No such role');

/** Active members holding a role: counted by role id, never by comparing a role to a name. */
function membersOf(tenantId: string, roleId: string): number {
  return mockStaffOf(tenantId).filter((member) => [member.roleId].includes(roleId)).length;
}

function summary(tenantId: string, roleId: string): RoleSummary {
  return {
    id: roleId,
    name: mockRoleName(tenantId, roleId),
    builtIn: BUILT_IN.has(roleId),
    permissionCount: mockRoleGrants(tenantId, roleId).length,
    memberCount: membersOf(tenantId, roleId),
  };
}

function detail(tenantId: string, roleId: string): RoleDetail {
  const { id, name, builtIn, memberCount } = summary(tenantId, roleId);
  return {
    id,
    name,
    builtIn,
    memberCount,
    permissions: mockRoleGrants(tenantId, roleId),
    updatedAt: '2026-11-01T09:00:00.000Z',
  };
}

const sameName = (tenantId: string, roleId: string, name: string) =>
  mockRoleName(tenantId, roleId).toLowerCase() === name.toLowerCase();

export const rolesHandlers = [
  http.get('*/api/permission-catalog', ({ request }) => {
    const access = authorize(request, { permission: READ });
    if ('denied' in access) return access.denied;
    const items = mockRoleGrants(access.tenantId, 'admin').map(({ permission }) => ({
      permission,
      description: `Allows ${permission}`,
      feature: permission.split(':')[0] ?? permission,
    }));
    return HttpResponse.json<PermissionCatalog>({ items });
  }),

  http.get('*/api/roles', ({ request }) => {
    const access = authorize(request, { permission: READ });
    if ('denied' in access) return access.denied;
    const items = mockRoleIds(access.tenantId)
      .map((id) => summary(access.tenantId, id))
      // Built-in roles first, then by name.
      .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name));
    return HttpResponse.json<RoleList>({ items });
  }),

  http.post('*/api/roles', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE });
    if ('denied' in access) return access.denied;
    const body = (await request.json()) as { name: string; permissions: unknown[] };
    const name = body.name.trim().replace(/\s+/g, ' ');
    const id = idFrom(name);
    if (!name || !id) return error(400, 'validation_failed', 'A role needs a name');
    const clash = mockRoleIds(access.tenantId).some(
      (existing) => existing === id || sameName(access.tenantId, existing, name),
    );
    if (clash) return error(409, 'role_exists', 'That name is taken');
    names.set(nameKey(access.tenantId, id), name);
    setRolePermissions(access.tenantId, id, body.permissions as Grants);
    return HttpResponse.json<RoleDetail>(detail(access.tenantId, id), { status: 201 });
  }),

  http.get('*/api/roles/:roleId', ({ request, params }) => {
    const access = authorize(request, { permission: READ });
    if ('denied' in access) return access.denied;
    const id = String(params.roleId);
    if (!mockRoleIds(access.tenantId).includes(id)) return notFound();
    return HttpResponse.json<RoleDetail>(detail(access.tenantId, id));
  }),

  http.put('*/api/roles/:roleId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE });
    if ('denied' in access) return access.denied;
    const id = String(params.roleId);
    if (!mockRoleIds(access.tenantId).includes(id)) return notFound();
    const body = (await request.json()) as { name?: string; permissions?: unknown[] };
    if (body.name !== undefined) {
      const name = body.name.trim().replace(/\s+/g, ' ');
      if (name !== mockRoleName(access.tenantId, id)) {
        if (BUILT_IN.has(id)) return error(409, 'built_in_role', 'Built-in roles keep their name');
        const clash = mockRoleIds(access.tenantId).some(
          (other) => other !== id && sameName(access.tenantId, other, name),
        );
        if (clash) return error(409, 'role_exists', 'That name is taken');
        names.set(nameKey(access.tenantId, id), name);
      }
    }
    if (body.permissions) setRolePermissions(access.tenantId, id, body.permissions as Grants);
    return HttpResponse.json<RoleDetail>(detail(access.tenantId, id));
  }),

  http.delete('*/api/roles/:roleId', ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE });
    if ('denied' in access) return access.denied;
    const id = String(params.roleId);
    if (!mockRoleIds(access.tenantId).includes(id)) return notFound();
    if (BUILT_IN.has(id)) return error(409, 'built_in_role', 'Built-in roles cannot be deleted');
    if (membersOf(access.tenantId, id) > 0) {
      return error(409, 'role_in_use', 'Members still hold this role');
    }
    deleteMockRole(access.tenantId, id);
    names.delete(nameKey(access.tenantId, id));
    return new HttpResponse(null, { status: 204 });
  }),
];
