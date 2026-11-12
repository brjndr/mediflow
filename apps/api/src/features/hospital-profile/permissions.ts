import type { PermissionDefinition } from '../../core/access/registry.js';

/** The hospital's own letterhead details: address, phone, registration number and GSTIN. */
export const HOSPITAL_PROFILE_PERMISSIONS = [
  {
    id: 'hospitalProfile:read',
    description: 'See the hospital’s address, phone, registration number and GSTIN',
    defaults: { admin: 'all' },
  },
  {
    id: 'hospitalProfile:manage',
    description: 'Change the hospital’s address, phone, registration number and GSTIN',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
