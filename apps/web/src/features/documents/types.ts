import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A file kept on a patient's record (#194, #189). */
export type PatientDocument = Schemas['PatientDocument'];
export type PatientDocumentPage = Schemas['PatientDocumentPage'];
export type PatientDocumentUpload = Schemas['PatientDocumentUpload'];
export type PatientDocumentCreate = Schemas['PatientDocumentCreate'];
export type DocumentCategory = PatientDocumentCreate['category'];
export type DocumentStatus = PatientDocument['status'];

/** How long a category is kept (#194, #561): `years` null keeps it for ever. */
export type RetentionRule = Schemas['DocumentRetentionRule'];
export type RetentionRuleStatus = Schemas['DocumentRetentionRuleStatus'];

/** A legal hold (#559, #628): while active the retention sweep leaves the document(s) alone. */
export type LegalHold = Schemas['DocumentLegalHold'];
export type LegalHoldPage = Schemas['DocumentLegalHoldPage'];
