import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Wards and beds are the hospital's structure: those who admit, nurse and round need to see
 * them, and the hospital's admin keeps them. Putting a patient in a bed is the admission
 * module's, with permissions of its own.
 */
export const WARD_PERMISSIONS = [
  {
    id: 'ward:read',
    description: 'See the wards, rooms and beds of the hospital, and its bed categories',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      receptionist: 'all',
    },
  },
  {
    id: 'ward:manage',
    description:
      'Add, change, archive and restore wards, rooms, beds and bed categories, and block a bed',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
