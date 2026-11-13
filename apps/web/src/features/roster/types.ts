import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A person on duty for a stretch of time (OP-01, #195). Names a member of staff, never a patient. */
export type RosterShift = Schemas['RosterShift'];
export type RosterShiftPage = Schemas['RosterShiftPage'];
export type RosterShiftCreate = Schemas['RosterShiftCreate'];
export type ShiftKind = Schemas['ShiftKind'];

/** A request for time off (#591): asked by the person, decided by someone else. Staff only. */
export type RosterLeave = Schemas['RosterLeave'];
export type RosterLeavePage = Schemas['RosterLeavePage'];
export type LeaveStatus = Schemas['LeaveStatus'];

/** A hospital's own shift template (#592): the hours of a shift on the hospital's clock. */
export type ShiftTemplate = Schemas['ShiftTemplate'];
export type ShiftTemplatePage = Schemas['ShiftTemplatePage'];
export type ShiftTemplateCreate = Schemas['ShiftTemplateCreate'];
/** A week copied forward and what was left out; a shift handed over or exchanged. */
export type CopyWeekBody = Schemas['CopyWeekBody'];
export type CopyWeekResult = Schemas['CopyWeekResult'];
export type ShiftSwapBody = Schemas['ShiftSwapBody'];
export type ShiftSwapResult = Schemas['ShiftSwapResult'];
