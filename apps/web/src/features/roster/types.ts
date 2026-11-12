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
