// Public surface of the feature. Other features and core import from here only.
export { patientsFeature } from './manifest';
// What a contribution to the `patient.detail.tabs` slot renders to become a tab.
export { DetailTab } from './components/DetailTabs';
export type { PatientSummary } from './types';
// A search box to choose a patient in another feature's screen. Needs `patient:read`.
export { PatientSearch } from './components/PatientSearch';
