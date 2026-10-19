import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** One reading of vital signs of a patient at one hospital (`tenantId`). Append-only. */
export type Vitals = Schemas['Vitals'];
export type VitalsCreate = Schemas['VitalsCreate'];
export type VitalsPage = Schemas['VitalsPage'];
export type VitalRange = Schemas['VitalRange'];
export type VitalRanges = Schemas['VitalRanges'];

/** A patient's allergies, with whether they were ever asked about. */
export type AllergyList = Schemas['AllergyList'];
export type AllergyListUpdate = Schemas['AllergyListUpdate'];
export type Allergy = Schemas['Allergy'];
export type AllergySeverity = Schemas['AllergySeverity'];
export type AllergyStatus = Schemas['AllergyStatus'];
