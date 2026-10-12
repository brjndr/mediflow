import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Who the hospital's doctors are and when they work is something every role that deals with
 * patients needs to see. The hospital's admin keeps the profiles and the hours.
 */
export const DOCTOR_PERMISSIONS = [
  {
    id: 'doctor:read',
    description: 'See the hospital’s doctors, their departments and their working hours',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      receptionist: 'all',
      pharmacist: 'all',
      lab_technician: 'all',
      radiologist: 'all',
    },
  },
  {
    id: 'doctor:manage',
    description: 'Create and change doctor profiles and their working hours',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
