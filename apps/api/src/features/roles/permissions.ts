import type { PermissionDefinition } from '../../core/access/registry.js';

/** Who may see and change what each role of the hospital may do. */
export const ROLE_PERMISSIONS = [
  {
    id: 'role:read',
    description: 'See the hospital’s roles and what each one may do',
    defaults: { admin: 'all' },
  },
  {
    id: 'role:manage',
    description: 'Create, edit and delete custom roles and change what any role may do',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
