import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/**
 * A lab order as the laboratory works it (#90): who it is for, the test as ordered, the sample it
 * needs, and its newest sample. The endpoints are in the planned contract until the laboratory
 * API (#95) has them.
 */
export type LabWorkItem = Schemas['LabWorkItem'];
export type LabWorkItemPage = Schemas['LabWorkItemPage'];
export type LabSample = Schemas['LabSample'];
export type LabStage = Schemas['LabStage'];
export type LabSampleStatus = Schemas['LabSampleStatus'];
export type LabRejectReason = Schemas['LabRejectReason'];
export type LabSampleReject = Schemas['LabSampleReject'];
export type OrderPriority = Schemas['OrderPriority'];
