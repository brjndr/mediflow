import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A closed encounter whose record is not complete, and what is missing (MR-04, #192). */
export type IncompleteRecord = Schemas['IncompleteRecord'];
export type IncompleteRecordPage = Schemas['IncompleteRecordPage'];
export type RecordGap = Schemas['RecordGap'];
export type EncounterKind = Schemas['EncounterType'];

/** A diagnosis recorded as text, waiting for a code, or coded. */
export type CodingItem = Schemas['CodingItem'];
export type CodingItemPage = Schemas['CodingItemPage'];
export type CodingState = Schemas['CodingState'];

/** A request for a copy of a patient's record, from the patient, an insurer, a court and so on. */
export type RecordRequest = Schemas['RecordRequest'];
export type RecordRequestPage = Schemas['RecordRequestPage'];
export type RecordRequestCreate = Schemas['RecordRequestCreate'];
export type RecordRequestClose = Schemas['RecordRequestClose'];
export type RecordRequestState = Schemas['RecordRequestState'];
export type RecordRequester = Schemas['RecordRequester'];
