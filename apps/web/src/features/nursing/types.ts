import type { components } from '@mediflow/contract';

export type WardVital = components['schemas']['WardVital'];
export type WardVitalPage = components['schemas']['WardVitalPage'];
export type WardVitalCreate = components['schemas']['WardVitalCreate'];

/** What the worklist and the vitals screen read of an admission. */
export interface StayRow {
  id: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  status: 'admitted' | 'discharged';
  admittedAt: string;
  doctorName: string;
  bed?: { bedNumber: string; wardId: string; wardName: string };
}
export interface StayPage {
  items: StayRow[];
  nextCursor: string | null;
  total?: number;
}
export interface WardOption {
  id: string;
  name: string;
}

export type MarOrder = components['schemas']['MarOrder'];
export type MarOrderPage = components['schemas']['MarOrderPage'];
export type MarEntry = components['schemas']['MarEntry'];
export type MarEntryPage = components['schemas']['MarEntryPage'];
export type MarEntryCreate = components['schemas']['MarEntryCreate'];
export type MarEntryCorrect = components['schemas']['MarEntryCorrect'];
export type MarOutcome = components['schemas']['MarOutcome'];
