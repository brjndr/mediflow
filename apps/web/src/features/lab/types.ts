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

/**
 * The results of a lab order (#91): what is resulted (the test, or each test of a panel) with the
 * patient's range, and every result, corrections included. A caller who may neither enter nor
 * verify gets verified results only, and `awaitingVerification` names the tests still to verify.
 */
export type LabOrderResults = Schemas['LabOrderResults'];
export type LabAnalyte = Schemas['LabAnalyte'];
export type LabResult = Schemas['LabResult'];
export type LabResultFlag = Schemas['LabResultFlag'];
export type LabResultRange = Schemas['LabResultRange'];
export type LabResultEntry = Schemas['LabResultEntry'];
export type LabResultAmend = Schemas['LabResultAmend'];
