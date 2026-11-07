import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A file kept on a patient's record (#194, #189). */
export type PatientDocument = Schemas['PatientDocument'];
export type PatientDocumentPage = Schemas['PatientDocumentPage'];
export type PatientDocumentUpload = Schemas['PatientDocumentUpload'];
export type PatientDocumentCreate = Schemas['PatientDocumentCreate'];
export type DocumentCategory = PatientDocumentCreate['category'];
export type DocumentStatus = PatientDocument['status'];
