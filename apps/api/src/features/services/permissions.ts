import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The price catalog is reference data: everyone who orders, performs or bills something needs to
 * see what it is and what it costs, and the hospital's admin keeps the catalog.
 */
export const SERVICE_PERMISSIONS = [
  {
    id: 'service:read',
    description: 'See the services the hospital charges for, and their prices',
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
    id: 'service:manage',
    description: 'Add, change, archive and restore services, and set their prices',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
