import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The test catalog is reference data: those who order a test, collect its sample, perform it and
 * bill it need to see what it is, and the hospital's admin keeps the catalog.
 */
export const LAB_TEST_PERMISSIONS = [
  {
    id: 'labTest:read',
    description: 'See the tests and panels the laboratory offers, and their reference ranges',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      receptionist: 'all',
      lab_technician: 'all',
    },
  },
  {
    id: 'labTest:manage',
    description: 'Add, change, archive and restore tests and panels, and set reference ranges',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
