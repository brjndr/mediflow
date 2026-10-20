// Public surface of the feature. Other features and core import from here only.
export { triageFeature } from './manifest';
// The patient's allergies and newest vitals, for the consultation view (#80).
export { TriageSummary } from './components/TriageSummary';
// The patient's allergies, for the checks of prescribing (#81).
export { useAllergies } from './hooks/use-triage';
export type { Allergy, AllergyList, Vitals } from './types';
