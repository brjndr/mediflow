import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** One line of the hospital's audit log: record ids only, never a patient's name. */
export type AuditEntry = Schemas['AuditEntry'];
export type AuditPage = Schemas['AuditPage'];
export type ReportRun = Schemas['ReportRun'];
