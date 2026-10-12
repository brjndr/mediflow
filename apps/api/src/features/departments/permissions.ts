import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Departments are reference data: every role that works with patients or doctors needs to see
 * them, and the hospital's admin keeps the list.
 */
export const DEPARTMENT_PERMISSIONS = [
  {
    id: 'department:read',
    description: 'See the hospital’s departments',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      receptionist: 'all',
      pharmacist: 'all',
      lab_technician: 'all',
      radiologist: 'all',
    },
  },
  {
    id: 'department:manage',
    description: 'Add, rename, archive and restore departments',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
