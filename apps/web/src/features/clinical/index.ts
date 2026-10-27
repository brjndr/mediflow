// Public surface of the feature. Other features and core import from here only.
export { clinicalFeature } from './manifest';
export type { ClinicalNote, Diagnosis, Encounter } from './types';
// Whether a recorded allergy is named in a medicine's names, for the pharmacy's warning (#100).
export { matchesAllergy } from './prescription-checks';
