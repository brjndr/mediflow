// Public surface of the feature. Other features and core import from here only.
export { triageFeature } from './manifest';
// The patient's allergies and newest vitals, for the consultation view (#80).
export { TriageSummary } from './components/TriageSummary';
// The patient's allergies, for the checks of prescribing (#81).
export { useAllergies } from './hooks/use-triage';
export type { Allergy, AllergyList, Vitals } from './types';
// What a printed document carries of triage (#398): plain text, each part for its permission.
export { TriagePrintout } from './components/TriagePrintout';
export { useTriagePrintParts } from './hooks/use-triage-print';
export { readTriageForPrint } from './api';
export type { PrintableTriage } from './types';
