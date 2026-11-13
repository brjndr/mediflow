import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The "Admissions and beds (ADT)" row of `docs/PRODUCT.md`: the admit desk admits, doctors admit
 * and discharge, nurses transfer, view and keep the beds ready, and the admin does all of it.
 */
export const ADMISSION_PERMISSIONS = [
  {
    id: 'admission:read',
    description: 'See admissions, who is in which bed, and the bed board with its patients',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      receptionist: 'all',
      pharmacist: 'all',
      lab_technician: 'all',
    },
  },
  {
    id: 'admission:create',
    description: 'Admit a patient, with or without a bed',
    defaults: { admin: 'all', doctor: 'all', receptionist: 'all' },
  },
  {
    id: 'admission:transfer',
    description: 'Give an admitted patient a bed, or move them to another',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'admission:discharge',
    description: 'Discharge an admitted patient, closing the stay and freeing the bed',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'discharge:clearNursing',
    description: 'Mark the nursing clearance for a discharge done, or open it again',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'discharge:clearPharmacy',
    description: 'Mark the pharmacy clearance for a discharge done, or open it again',
    defaults: { admin: 'all', doctor: 'all', pharmacist: 'all' },
  },
  {
    id: 'discharge:clearLab',
    description: 'Mark the laboratory clearance for a discharge done, or open it again',
    defaults: { admin: 'all', doctor: 'all', lab_technician: 'all' },
  },
  {
    id: 'dischargeSummary:read',
    description: 'Read and print the discharge summary of a stay',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'dischargeSummary:create',
    description: 'Write and change the draft of a discharge summary',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'dischargeSummary:sign',
    description: 'Sign a discharge summary, which can never be changed after, and add addenda',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'admission:cancel',
    description: 'Cancel an admission made by mistake, with a reason, freeing its bed',
    defaults: { admin: 'all', doctor: 'all', receptionist: 'all' },
  },
  {
    id: 'bed:reserve',
    description: 'Hold a bed for a patient until a time, or let the hold go',
    defaults: { admin: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'bed:update',
    description: 'Mark a bed being cleaned or ready',
    defaults: { admin: 'all', nurse: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
