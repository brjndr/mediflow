import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The emergency rows of `docs/PRODUCT.md`: the front desk and nurses register arrivals, nurses
 * and doctors triage, and everyone who works in the department reads the board.
 */
export const EMERGENCY_PERMISSIONS = [
  {
    id: 'emergency:read',
    description: 'See the emergency department’s board',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'emergency:register',
    description: 'Register an arrival and link an unidentified patient to a record',
    defaults: { admin: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'emergency:triage',
    description: 'Set or change the triage category of a case',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
