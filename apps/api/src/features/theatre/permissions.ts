import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The operation theatre rows of `docs/PRODUCT.md`: surgeons and nurses see the schedule, book and
 * run surgeries; only the hospital's admin keeps the list of theatres.
 */
export const THEATRE_PERMISSIONS = [
  {
    id: 'theatre:read',
    description: 'See the theatres, the surgery schedule and the consumables used',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'theatre:manage',
    description: 'Add, rename and retire operation theatres',
    defaults: { admin: 'all' },
  },
  {
    id: 'surgery:schedule',
    description: 'Book a surgery in a theatre, move it to another time or cancel it',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'surgery:perform',
    description: 'Start and complete a surgery and record the consumables used',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
