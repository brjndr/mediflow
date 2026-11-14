import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The operations rows of `docs/PRODUCT.md` (R4): the hospital admin keeps the rosters, the blood
 * bank, the fleet and the cleaning work; nurses work them day to day; the lab technician runs the
 * blood bank's tests and stock; a doctor sees the roster and the blood stock.
 */
export const OPERATIONS_PERMISSIONS = [
  {
    id: 'roster:read',
    description: 'See who is on duty, in which department and when',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      receptionist: 'all',
      pharmacist: 'all',
      lab_technician: 'all',
      radiologist: 'all',
      store_keeper: 'all',
    },
  },
  {
    id: 'roster:manage',
    description: 'Schedule and cancel duty shifts',
    defaults: { admin: 'all' },
  },
  {
    id: 'roster:requestLeave',
    description: 'Ask for leave for yourself, and withdraw your own request',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      receptionist: 'all',
      pharmacist: 'all',
      lab_technician: 'all',
      radiologist: 'all',
      store_keeper: 'all',
    },
  },
  {
    id: 'bloodUnit:read',
    description: 'See the blood units in stock and the history of each',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', lab_technician: 'all' },
  },
  {
    id: 'bloodUnit:manage',
    description: 'Register blood units, move them through testing, and discard them',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'bloodUnit:issue',
    description: 'Reserve a blood unit for a patient, issue it and record its transfusion',
    defaults: { admin: 'all', nurse: 'all', lab_technician: 'all' },
  },
  {
    id: 'bloodUnit:test',
    description: 'Record the screening and cross-match of a blood unit',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'bloodDonor:read',
    description: 'Search blood donors and see a donor’s record and collections',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'bloodDonor:manage',
    description: 'Register blood donors, record collections and defer a donor',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'transfusionReaction:read',
    description: 'See transfusion reactions, and trace a blood unit from donor to recipient',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', lab_technician: 'all' },
  },
  {
    id: 'transfusionReaction:record',
    description: 'Report a transfusion reaction and add to it',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', lab_technician: 'all' },
  },
  {
    id: 'patient.bloodGroup:read',
    description: 'See a patient’s blood group and the entries before it',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', lab_technician: 'all' },
  },
  {
    id: 'patient.bloodGroup:update',
    description: 'Record or correct a patient’s blood group',
    defaults: { admin: 'all', lab_technician: 'all' },
  },
  {
    id: 'ambulance:read',
    description: 'See the ambulances and their trips',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'ambulance:manage',
    description: 'Add ambulances and take them in and out of service',
    defaults: { admin: 'all' },
  },
  {
    id: 'ambulance:dispatch',
    description: 'Request a trip, send an ambulance and follow the trip to its end',
    defaults: { admin: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'cleaningTask:read',
    description: 'See the bed cleaning tasks',
    defaults: { admin: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'cleaningTask:work',
    description: 'Start and finish a cleaning task, which makes the bed ready',
    defaults: { admin: 'all', nurse: 'all' },
  },
  {
    id: 'cleaningTask:manage',
    description: 'Create, assign and cancel cleaning tasks',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
