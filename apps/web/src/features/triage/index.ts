// Public surface of the feature. Other features and core import from here only.
export { triageFeature } from './manifest';
// The patient's allergies and newest vitals, for the consultation view (#80).
export { TriageSummary } from './components/TriageSummary';
export type { AllergyList, Vitals } from './types';
