import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/**
 * When a patient should come back after an encounter, to whom, and the appointment it was booked
 * as (#88). Its state is read from that appointment by the server.
 */
export type FollowUp = Schemas['FollowUp'];
export type FollowUpPage = Schemas['FollowUpPage'];
export type FollowUpCreate = Schemas['FollowUpCreate'];
export type FollowUpBook = Schemas['FollowUpBook'];
export type FollowUpState = Schemas['FollowUpState'];
