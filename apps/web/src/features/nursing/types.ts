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
  doctorId: string;
  doctorName: string;
  encounterId: string;
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

export type ProgressNote = components['schemas']['ProgressNote'];
export type ProgressNotePage = components['schemas']['ProgressNotePage'];
export type ProgressNoteKind = components['schemas']['ProgressNoteKind'];
export type ProgressNoteCreate = components['schemas']['ProgressNoteCreate'];
export type ProgressNoteUpdate = components['schemas']['ProgressNoteUpdate'];
export type ProgressNoteVersion = components['schemas']['ProgressNoteVersion'];
export type ProgressNoteVersionPage = components['schemas']['ProgressNoteVersionPage'];

export type WardFluid = components['schemas']['WardFluid'];
export type WardFluidPage = components['schemas']['WardFluidPage'];
export type WardFluidCreate = components['schemas']['WardFluidCreate'];
export type WardFluidCorrect = components['schemas']['WardFluidCorrect'];
export type FluidKind = components['schemas']['FluidKind'];
export type FluidTotals = components['schemas']['FluidTotals'];

export type CarePlan = components['schemas']['CarePlan'];
export type CarePlanPage = components['schemas']['CarePlanPage'];
export type CarePlanTask = components['schemas']['CarePlanTask'];
export type CarePlanCreate = components['schemas']['CarePlanCreate'];
export type CarePlanTaskCreate = components['schemas']['CarePlanTaskCreate'];

export type WardDietOrder = components['schemas']['WardDietOrder'];
export type WardDiet = components['schemas']['WardDiet'];
export type KitchenListItem = components['schemas']['KitchenListItem'];
export type KitchenListPage = components['schemas']['KitchenListPage'];
