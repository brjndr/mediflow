import type { components } from '@mediflow/contract';

/** A bed in use as the bed board shows it, with the patient in it when it is occupied. */
export type BoardBed = components['schemas']['BoardBed'];
export type BoardBedPage = components['schemas']['BoardBedPage'];
export type BoardBedStatus = components['schemas']['BoardBedStatus'];
export type BedCounts = components['schemas']['BedCounts'];
export type WardOption = { id: string; name: string };
export const DISCHARGE_TYPES = [
  'routine',
  'against_advice',
  'referred',
  'absconded',
  'deceased',
] as const;
export type DischargeType = (typeof DISCHARGE_TYPES)[number];
export type Admission = components['schemas']['Admission'];
export type AdmissionPage = components['schemas']['AdmissionPage'];
export type AdmissionType = components['schemas']['AdmissionType'];
export type AdmissionCreate = components['schemas']['AdmissionCreate'];
export type BedStay = components['schemas']['BedStay'];

/** The discharge plan of a stay (DS-01, #164): advice and the clearances done by hand. */
export type DischargePlan = components['schemas']['DischargePlan'];
export type DischargeClearance = components['schemas']['DischargeClearance'];
export type ClearanceKind = components['schemas']['DischargeClearanceKind'];
export const CLEARANCE_KINDS: readonly ClearanceKind[] = ['nursing', 'pharmacy', 'lab'];

/**
 * The clearances a way of leaving needs before the patient goes. The bill is checked separately
 * by the hospital's discharge policy (#167). Someone who absconded cannot be cleared by anyone.
 */
export const REQUIRED_CLEARANCES: Record<DischargeType, readonly ClearanceKind[]> = {
  routine: ['nursing', 'pharmacy', 'lab'],
  referred: ['nursing', 'pharmacy', 'lab'],
  against_advice: ['nursing', 'pharmacy'],
  deceased: ['nursing', 'pharmacy'],
  absconded: [],
};

/** The required clearances of a plan that are not cleared yet. */
export function openClearances(plan: DischargePlan, type: DischargeType): ClearanceKind[] {
  return REQUIRED_CLEARANCES[type].filter(
    (kind) => plan.clearances.find((each) => each.kind === kind)?.status !== 'cleared',
  );
}

/** The discharge summary of a stay (DS-02, #165): a draft, then signed and never changed. */
export type DischargeSummary = components['schemas']['DischargeSummary'];
export type DischargeSummarySave = components['schemas']['DischargeSummarySave'];
export type SummaryAddendum = components['schemas']['DischargeSummaryAddendum'];
export const SUMMARY_SECTIONS = [
  'diagnoses',
  'procedures',
  'course',
  'results',
  'medicines',
  'followUp',
] as const;
export type SummarySection = (typeof SUMMARY_SECTIONS)[number];
