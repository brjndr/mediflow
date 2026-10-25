import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Imaging (perform, report)" row of `docs/PRODUCT.md`: the radiologist does
 * everything. The admin holds every one, as in the clinical module and the laboratory: nobody
 * invites into a role that holds more than their own. A doctor sees an imaging order's status in
 * the consultation (`order:read`); its signed report there is a follow-up. Radiology works
 * the whole hospital's orders, so only the scope `all` reaches anything.
 */
export const RADIOLOGY_PERMISSIONS = [
  {
    id: 'imagingStudy:read',
    description:
      'See radiology’s worklist of imaging orders, with the name, MRN and date of birth of each patient',
    defaults: { admin: 'all', radiologist: 'all' },
  },
  {
    id: 'imagingStudy:schedule',
    description: 'Schedule, reschedule and unschedule imaging studies',
    defaults: { admin: 'all', radiologist: 'all' },
  },
  {
    id: 'imagingStudy:perform',
    description: 'Record that an imaging study was performed',
    defaults: { admin: 'all', radiologist: 'all' },
  },
  {
    id: 'imagingReport:write',
    description: 'Write and save the draft report of a performed imaging study',
    defaults: { admin: 'all', radiologist: 'all' },
  },
  {
    id: 'imagingReport:sign',
    description:
      'Sign an imaging report, which completes its order and can never be changed, and add signed addenda to it',
    defaults: { admin: 'all', radiologist: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
