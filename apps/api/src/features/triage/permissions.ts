import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Triage and vitals" row of `docs/PRODUCT.md`: nurses record, doctors view,
 * and the hospital admin holds all four to set the module up. The pharmacist reads allergies, for
 * the warning as a medicine is dispensed (#100).
 */
export const TRIAGE_PERMISSIONS = [
  {
    id: 'vitals:read',
    description: 'See a patient’s vital signs and chief complaints, and the normal ranges',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'vitals:record',
    description: 'Record and correct vital signs and the chief complaint',
    defaults: { admin: 'all', nurse: 'all' },
  },
  {
    id: 'allergy:read',
    description: 'See a patient’s allergies',
    // The pharmacist, to be warned of an allergy as a medicine is dispensed (#100).
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', pharmacist: 'all' },
  },
  {
    id: 'allergy:update',
    description: 'Record a patient’s allergies',
    defaults: { admin: 'all', nurse: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
