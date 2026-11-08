// Public surface of the feature. Other features and core import from here only.
export { staffFeature } from './manifest';
export type { StaffMember } from './types';
export { invalidateStaffRoles } from './hooks/use-staff';
export { useStaffOptions, type StaffOption } from './hooks/use-staff-options';
