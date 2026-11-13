import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** An insurer, a TPA or a corporate the hospital bills (`tenantId`). */
export type Payer = Schemas['Payer'];
export type PayerKind = Payer['kind'];
export type PayerPage = Schemas['PayerPage'];
export type PayerCreate = Schemas['PayerCreate'];
export type PayerUpdate = Schemas['PayerUpdate'];
export type PayerDetail = Schemas['PayerDetail'];
/** What a payer covers, the patient's share, limits and eligibility rules. */
export type PayerPlan = Schemas['PayerPlan'];
export type PayerPlanWrite = Schemas['PayerPlanWrite'];
export type PayerPlanUpdate = Schemas['PayerPlanUpdate'];
export type CoverageMode = PayerPlan['coverageMode'];
/** Prices for a payer's patients between two dates. Effective-dated, never edited. */
export type RateAgreement = Schemas['RateAgreement'];
export type RateAgreementCreate = Schemas['RateAgreementCreate'];

/** An insurance policy on a patient record, against a payer plan (IN-02, #182). */
export type PatientPolicy = Schemas['PatientPolicy'];
export type PatientPolicyCreate = Schemas['PatientPolicyCreate'];
export type PolicyRelationship = PatientPolicy['relationship'];
/** A request to the payer to approve the cost of a treatment, and its answer. */
export type PreAuth = Schemas['PreAuth'];
export type PreAuthCreate = Schemas['PreAuthCreate'];
export type PreAuthDecision = Schemas['PreAuthDecision'];
export type PreAuthStatus = PreAuth['status'];

export type CoverageSplit = Schemas['CoverageSplit'];
export type CoverageSplitLine = Schemas['CoverageSplitLine'];
