import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Prescription sets: lists of medicine lines a prescriber loads in one step. Whoever writes or
 * sees prescriptions reads them; a doctor keeps their own and the hospital's admin keeps the
 * sets shared with every prescriber. Sharing is a permission of its own, never a role name.
 */
export const PRESCRIPTION_SET_PERMISSIONS = [
  {
    id: 'prescriptionSet:read',
    description:
      'See the prescription sets shared with the hospital, the caller’s own, and own favourite medicines',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'prescriptionSet:manage',
    description:
      'Add, change and archive the caller’s own prescription sets, and keep own favourite medicines',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'prescriptionSet:manageShared',
    description: 'Add, change and archive the prescription sets shared with the whole hospital',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
