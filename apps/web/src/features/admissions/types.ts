import type { components } from '@mediflow/contract';

/** A bed in use as the bed board shows it, with the patient in it when it is occupied. */
export type BoardBed = components['schemas']['BoardBed'];
export type BoardBedPage = components['schemas']['BoardBedPage'];
export type BoardBedStatus = components['schemas']['BoardBedStatus'];
export type WardOption = { id: string; name: string };
export type Admission = components['schemas']['Admission'];
export type AdmissionPage = components['schemas']['AdmissionPage'];
export type AdmissionType = components['schemas']['AdmissionType'];
export type AdmissionCreate = components['schemas']['AdmissionCreate'];
