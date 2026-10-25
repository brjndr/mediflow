import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Lab (collect, result, verify)" row of `docs/PRODUCT.md`: the nurse
 * collects, the lab technician does everything, the doctor views results, acknowledges a critical
 * one and prints reports (#92), as the lab technician prints them. The admin holds every
 * one, as in the clinical module: nobody invites into a role that holds more than their own.
 * The laboratory works the whole hospital's orders, so only the scope `all` reaches anything.
 */
export const LAB_PERMISSIONS = [
  {
    id: 'labSample:read',
    description:
      'See the laboratory’s worklist and samples, with the name, MRN and date of birth of each patient',
    defaults: { admin: 'all', nurse: 'all', lab_technician: 'all' },
  },
  {
    id: 'labSample:collect',
    description: 'Record that a sample was collected, and print its label',
    defaults: { admin: 'all', nurse: 'all', lab_technician: 'all' },
  },
  {
    id: 'labSample:receive',
    description: 'Receive samples in the laboratory',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'labSample:reject',
    description: 'Reject a sample, so it is collected again',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'labSample:outsource',
    description: 'Send a sample to a partner laboratory, and record that its report came back',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'labResult:read',
    description: 'See the results of lab orders, with the patient they are for',
    defaults: { admin: 'all', doctor: 'all', lab_technician: 'all' },
  },
  {
    id: 'labResult:enter',
    description: 'Enter and correct lab results',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'labResult:verify',
    description: 'Verify lab results, which releases them and completes the order',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'labResult:acknowledge',
    description: 'Acknowledge a verified critical lab result, as the doctor who has seen it',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'labReport:print',
    description: 'Print the report of a lab order, with its verified results',
    defaults: { admin: 'all', doctor: 'all', lab_technician: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
