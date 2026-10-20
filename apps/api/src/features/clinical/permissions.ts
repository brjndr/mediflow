import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Clinical notes, diagnosis, orders" row of `docs/PRODUCT.md`: doctors do
 * all of it, and nurses get the limited view (the encounter, its orders and prescriptions, and
 * moving an order on) without the notes or the diagnoses. Diagnoses are a permission of their
 * own, so a role may see a visit without what it was for. The hospital admin holds every one, as
 * with triage: nobody gives a role more than they hold, so an admin without them could not invite
 * a doctor or a nurse. An admin with no doctor profile opens an encounter only for a doctor named.
 */
export const CLINICAL_PERMISSIONS = [
  {
    id: 'encounter:read',
    description:
      'See encounters (visits): when, with whom, whether open, and the name and MRN of the patient each is for',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'encounter:create',
    description: 'Start an encounter (a consultation)',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'encounter:update',
    description: 'Close or cancel an encounter',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'clinicalNote:read',
    description: 'Read clinical notes and their amendments',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'clinicalNote:write',
    description: 'Write, sign and amend clinical notes',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'diagnosis:read',
    description: 'See the diagnoses of an encounter',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'diagnosis:write',
    description: 'Record and retract diagnoses',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'order:read',
    description: 'See the lab, imaging, procedure, medication and diet orders of an encounter',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'order:create',
    description: 'Place lab, imaging, procedure and diet orders',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'order:update',
    description: 'Move an order on: accepted, in progress, completed',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'order:cancel',
    description: 'Cancel an order that has not started',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'prescription:read',
    description: 'See prescriptions',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'prescription:create',
    description: 'Write and revise prescriptions',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'encounter:print',
    description:
      'Print a prescription or the visit summary of an encounter (each print is recorded in the audit log)',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all' },
  },
  {
    id: 'referral:read',
    description: 'See the referrals of an encounter, with why the patient was referred',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'referral:create',
    description: 'Refer a patient to a department or a doctor, and cancel a referral',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'followUp:read',
    description:
      'See follow-ups and the follow-up due list: when each patient should come back, the name and MRN of the patient, and the note for whoever books it',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'followUp:create',
    description: 'Ask a patient to come back on a day, and cancel a follow-up',
    defaults: { admin: 'all', doctor: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
