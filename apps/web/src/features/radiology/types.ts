import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/**
 * An imaging order as radiology works it (#96): who it is for, the study as ordered, its
 * modality, its stage and its study once it has one. The endpoints are the radiology API's.
 */
export type ImagingWorkItem = Schemas['ImagingWorkItem'];
export type ImagingWorkItemPage = Schemas['ImagingWorkItemPage'];
export type ImagingStudy = Schemas['ImagingStudy'];
export type ImagingStage = Schemas['ImagingStage'];
export type ImagingModality = Schemas['ImagingModality'];
export type OrderPriority = Schemas['OrderPriority'];

/**
 * The report of a performed study (#97): a draft until a radiologist signs it, then never
 * changed; what is added later is a signed addendum.
 */
export type ImagingReport = Schemas['ImagingReport'];
export type ImagingReportStatus = Schemas['ImagingReportStatus'];
export type ImagingAddendum = Schemas['ImagingAddendum'];
export type ImagingLink = Schemas['ImagingLink'];
export type ImagingReportDraft = Schemas['ImagingReportDraft'];
export type AddendumReason = ImagingAddendum['reason'];
