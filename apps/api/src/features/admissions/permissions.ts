import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The "Admissions and beds (ADT)" row of `docs/PRODUCT.md`: the admit desk admits, doctors admit
 * and discharge, nurses transfer, view and keep the beds ready, and the admin does all of it.
 */
export const ADMISSION_PERMISSIONS = [
  {
    id: 'admission:read',
    description: 'See admissions, who is in which bed, and the bed board with its patients',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'admission:create',
    description: 'Admit a patient, with or without a bed',
    defaults: { admin: 'all', doctor: 'all', receptionist: 'all' },
  },
  {
    id: 'admission:transfer',
    description: 'Give an admitted patient a bed, or move them to another',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'admission:discharge',
    description: 'Discharge an admitted patient, closing the stay and freeing the bed',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'bed:update',
    description: 'Mark a bed being cleaned or ready',
    defaults: { admin: 'all', nurse: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
