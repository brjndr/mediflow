import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A visit of one patient at one hospital (`tenantId`): the spine every clinical record hangs on. */
export type Encounter = Schemas['Encounter'];
export type EncounterPage = Schemas['EncounterPage'];
export type EncounterCreate = Schemas['EncounterCreate'];
export type EncounterStatus = Schemas['EncounterStatus'];
export type EncounterType = Schemas['EncounterType'];

/** A note of an encounter: a draft only its author reads, then signed and never changed. */
export type ClinicalNote = Schemas['ClinicalNote'];
export type ClinicalNotePage = Schemas['ClinicalNotePage'];
export type ClinicalNoteStatus = Schemas['ClinicalNoteStatus'];

/** A diagnosis of an encounter. Never changed: retracted with a reason, and kept. */
export type Diagnosis = Schemas['Diagnosis'];
export type DiagnosisPage = Schemas['DiagnosisPage'];
export type DiagnosisCreate = Schemas['DiagnosisCreate'];
export type DiagnosisKind = Schemas['DiagnosisKind'];

/** A request for work for the patient. A medication order is a line of a prescription. */
export type Order = Schemas['Order'];
export type OrderStatus = Schemas['OrderStatus'];
export type OrderPage = Schemas['OrderPage'];
export type OrderCreate = Schemas['OrderCreate'];
export type OrderPriority = Schemas['OrderPriority'];
export type MedicationRoute = Schemas['MedicationRoute'];

/** Medication orders written together. Never changed: a revision replaces it. */
export type Prescription = Schemas['Prescription'];
/** A doctor's qualifications and registration, printed with the name (#397). */
export type Credentials = Schemas['DoctorCredentials'];
export type PrescriptionPage = Schemas['PrescriptionPage'];
export type PrescriptionCreate = Schemas['PrescriptionCreate'];
export type PrescriptionLine = Schemas['PrescriptionLine'];

/** A referral to a department of the hospital, or one of its doctors (#88). Cancelled, never changed. */
export type Referral = Schemas['Referral'];
export type ReferralPage = Schemas['ReferralPage'];
export type ReferralCreate = Schemas['ReferralCreate'];
export type ReferralUrgency = Schemas['ReferralUrgency'];
