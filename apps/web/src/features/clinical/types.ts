import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A visit of one patient at one hospital (`tenantId`): the spine every clinical record hangs on. */
export type Encounter = Schemas['Encounter'];
export type EncounterPage = Schemas['EncounterPage'];
export type EncounterCreate = Schemas['EncounterCreate'];
export type EncounterStatus = Schemas['EncounterStatus'];

/** A note of an encounter: a draft only its author reads, then signed and never changed. */
export type ClinicalNote = Schemas['ClinicalNote'];
export type ClinicalNotePage = Schemas['ClinicalNotePage'];
export type ClinicalNoteStatus = Schemas['ClinicalNoteStatus'];

/** A diagnosis of an encounter. Never changed: retracted with a reason, and kept. */
export type Diagnosis = Schemas['Diagnosis'];
export type DiagnosisPage = Schemas['DiagnosisPage'];
export type DiagnosisCreate = Schemas['DiagnosisCreate'];
export type DiagnosisKind = Schemas['DiagnosisKind'];
