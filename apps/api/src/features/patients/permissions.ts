import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Patient registration and demographics. Defaults follow the role matrix in the root CLAUDE.md:
 * clinical and front-desk roles register and edit, diagnostic and pharmacy roles view.
 */
export const PATIENT_PERMISSIONS = [
  {
    id: 'patient:read',
    description: 'Find patients and open their registration details',
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
    id: 'patient:create',
    description: 'Register a new patient',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'patient:update',
    description: 'Correct or update a patient’s registration details',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    // A field-level permission: without it the phone number is masked and the email and address
    // are left out of every answer.
    id: 'patient.contact:read',
    description: 'See a patient’s full phone number, email and address',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
