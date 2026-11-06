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
/** Something an allergy can name (#380): a catalog entry or a medicine's generic name. */
export type Allergen = Schemas['Allergen'];
export type AllergenKind = Schemas['AllergenKind'];
export type AllergenPage = Schemas['AllergenPage'];

/** What triage puts on paper (#398): a part is absent when the caller may not read it. */
export interface PrintableTriage {
  allergies?: AllergyList;
  /** The newest reading, or null when none was recorded. */
  vitals?: Vitals | null;
}
