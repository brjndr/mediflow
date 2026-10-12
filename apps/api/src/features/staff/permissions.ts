import type { PermissionDefinition } from '../../core/access/registry.js';

/** Managing who works at the hospital. More arrives with the staff and role management issues. */
export const STAFF_PERMISSIONS = [
  {
    id: 'staff:invite',
    description: 'Invite someone to join the hospital in a role',
    defaults: { admin: 'all' },
  },
  {
    id: 'staff:read',
    description: 'See who works at the hospital and which invitations are open',
    defaults: { admin: 'all' },
  },
  {
    id: 'staff:manage',
    description: 'Deactivate and reactivate members of staff, and end their sessions',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
