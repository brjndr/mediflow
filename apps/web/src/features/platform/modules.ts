/**
 * The modules a new hospital can start with: the feature flags of the web app's registered
 * features. PL-03 (#127) replaces this with the list the API gives. A module not in the list is
 * switched on later from the hospital's own page.
 */
export const STARTING_MODULES = [
  'patients',
  'departments',
  'doctors',
  'staff',
  'appointments',
  'queue',
  'triage',
  'clinical',
  'laboratory',
  'radiology',
  'inventory',
  'pharmacy',
  'purchasing',
  'billing',
  'reports',
  'services',
  'drugs',
  'lab_tests',
  'wards',
  'codes',
  'templates',
  'imports',
  'notices',
] as const;

/** The regions a hospital's data can live in. One for now; add a code here for another. */
export const REGIONS = ['in'] as const;
