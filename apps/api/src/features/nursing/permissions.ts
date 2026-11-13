import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Nursing and ward care (BE-24): nurses record and read; doctors read what the ward recorded and write progress notes on their rounds (#159);
 * the admin holds all (nobody gives a role more than they hold, so an admin without them could
 * not invite a nurse). Every write route also asks for the matching read, because its answer
 * shows what was recorded.
 */
export const NURSING_PERMISSIONS = [
  {
    id: 'nursingVitals:read',
    description: 'See the vital signs recorded on the ward for an admitted patient',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'nursingVitals:record',
    description: 'Record ward vital signs, and correct a reading with a reason',
    defaults: { admin: 'all', nurse: 'all' },
  },
  {
    id: 'mar:read',
    description:
      'See the medication chart of an admitted patient: orders, doses given and not given',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'mar:record',
    description:
      'Record a dose given, withheld, refused or missed, and correct an entry with a reason',
    defaults: { admin: 'all', nurse: 'all' },
  },
  {
    id: 'progressNote:read',
    description: 'Read the nursing progress notes of an admitted patient and their history',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'progressNote:write',
    description: 'Write progress notes (nursing, ward round) and edit your own',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'fluidBalance:read',
    description: 'See the fluid intake and output of an admitted patient, with the totals',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'fluidBalance:record',
    description: 'Record fluid taken in and put out, and correct an entry with a reason',
    defaults: { admin: 'all', nurse: 'all' },
  },
  {
    id: 'carePlan:read',
    description: 'See the care plans of an admitted patient and their tasks',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'carePlan:write',
    description: 'Start a care plan, add tasks, mark a task done and end a plan',
    defaults: { admin: 'all', nurse: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
