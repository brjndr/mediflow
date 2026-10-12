import type { components } from '@mediflow/contract';

/** A test or a panel the laboratory offers (`tenantId`). The catalog holds no patient data. */
export type LabTest = components['schemas']['LabTest'];
export type LabTestPage = components['schemas']['LabTestPage'];
export type LabTestCreate = components['schemas']['LabTestCreate'];
export type LabTestUpdate = components['schemas']['LabTestUpdate'];
export type LabTestComponent = components['schemas']['LabTestComponent'];
/** What is normal for one sex in one span of age. */
export type LabRange = components['schemas']['LabRange'];
export type LabRanges = components['schemas']['LabRanges'];
export type LabDepartment = LabTest['department'];
export type LabTestKind = LabTest['kind'];
export type LabResultType = LabTest['resultType'];
export type LabSampleType = LabTest['sampleType'];
export type LabRangeSex = LabRange['sex'];
/** The sex of a patient a range is looked up for. */
export type PatientSex = 'male' | 'female' | 'other';
