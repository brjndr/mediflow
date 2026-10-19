import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Appointments and queue" and "Triage and vitals" rows of `docs/PRODUCT.md`:
 * the desk issues tokens, doctors and nurses call them (a nurse calls for a doctor by choosing the
 * doctor), and everyone who works the OPD sees the board.
 */
export const QUEUE_PERMISSIONS = [
  {
    id: 'queue:read',
    description: 'See today’s OPD queue, with the name and MRN of the patient of each token',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'queue:create',
    description: 'Issue queue tokens',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'queue:call',
    description:
      'Call the next patient, call again, skip, put back in the queue and set a priority',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
