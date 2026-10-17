import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the roles table in `docs/PRODUCT.md`: the desk books and changes, doctors and
 * nurses see the whole hospital's appointments (a doctor covers for a colleague). A hospital that
 * wants doctors to see only their own gives `appointment:read` the scope `own`.
 */
export const APPOINTMENT_PERMISSIONS = [
  {
    id: 'appointment:read',
    description: 'See appointments, with the name and MRN of the patient each is for',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'appointment:create',
    description: 'Book appointments',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'appointment:update',
    description: 'Move, cancel, complete and mark appointments as a no-show',
    defaults: { admin: 'all', receptionist: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
