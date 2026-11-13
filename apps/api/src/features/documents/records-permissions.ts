import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The permissions of the `consents` and `records` modules (MR-02, MR-04). Both are web-only until
 * their APIs exist; they are declared here so the platform's module list offers their switches
 * and the role editor knows the permissions. They sit with documents, the API they build on.
 */
export const CONSENT_PERMISSIONS = [
  {
    id: 'consent:read',
    description: 'See the consents recorded for a patient',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'consent:sign',
    description: 'Record a patient’s consent to a procedure, admission or treatment',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'certificate:read',
    description: 'See the certificates issued to a patient',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'certificate:issue',
    description: 'Issue a medical, fitness or birth certificate',
    defaults: { admin: 'all', doctor: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];

export const RECORDS_PERMISSIONS = [
  {
    id: 'medicalRecord:read',
    description: 'See closed encounters in the medical records desk',
    defaults: { admin: 'all' },
  },
  {
    id: 'medicalRecord:code',
    description: 'Code the diagnoses and procedures of a closed encounter',
    defaults: { admin: 'all' },
  },
  {
    id: 'recordRequest:read',
    description: 'See requests for copies of a patient’s record',
    defaults: { admin: 'all' },
  },
  {
    id: 'recordRequest:manage',
    description: 'Record, fulfil and refuse requests for copies of a patient’s record',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];

/** Requests to correct a record (#556): anyone who sees it asks, a second person decides. */
export const CORRECTION_PERMISSIONS = [
  {
    id: 'correction:read',
    description: 'See the requests to correct a patient’s record, and why',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'correction:request',
    description: 'Ask for a correction to a patient’s record, with a reason',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'correction:decide',
    description: 'Approve or reject a request to correct a record (never one’s own)',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
