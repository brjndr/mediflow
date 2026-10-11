import type { components } from '@mediflow/contract';

/** A patient as listed: compact, with no clinical data. Belongs to one hospital (`tenantId`). */
export type PatientSummary = components['schemas']['PatientSummary'];
export type PatientPage = components['schemas']['PatientPage'];
export type PatientSort = 'name' | '-name' | 'mrn' | '-mrn';
export type PatientRecord = components['schemas']['PatientRecord'];
export type PatientCreate = components['schemas']['PatientCreate'];
export type PatientUpdate = components['schemas']['PatientUpdate'];
export type PatientDuplicateQuery = components['schemas']['PatientDuplicateQuery'];
export type PatientDuplicateMatches = components['schemas']['PatientDuplicateMatches'];
export type PatientDuplicateMatch = components['schemas']['PatientDuplicateMatch'];
