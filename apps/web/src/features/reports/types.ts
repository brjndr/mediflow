import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A report worked out on the spot, as a table of counts and money. It holds no patient record. */
export type ReportResult = Schemas['ReportResult'];
export type ReportColumn = Schemas['ReportColumn'];
/** A stored report: made by a job, kept with a CSV file for the hospital's retention. */
export type ReportRun = Schemas['ReportRun'];
export type ReportRunPage = Schemas['ReportRunPage'];
export type ReportLimits = Schemas['ReportLimits'];
export type ReportDownload = Schemas['ReportDownload'];
export type OutstandingInvoice = Schemas['OutstandingInvoice'];
export type OutstandingInvoicePage = Schemas['OutstandingInvoicePage'];
export type AgeBand = Schemas['OutstandingInvoicesRequest']['band'];
export type ReportKind = ReportResult['kind'];
export type ReportRunStatus = ReportRun['status'];
