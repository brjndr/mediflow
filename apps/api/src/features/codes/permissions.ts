import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The code sets are reference data: everyone who records, reads or bills a diagnosis or a
 * procedure searches them. Which codes are the hospital's favourites is the admin's to say.
 */
export const CODE_PERMISSIONS = [
  {
    id: 'code:read',
    description: 'Search the diagnosis and procedure codes',
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
    id: 'code:manage',
    description: 'Choose which codes are the hospital’s favourites',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
