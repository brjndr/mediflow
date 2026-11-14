import { api, apiFetchOnce, requireData } from '@/shared/api';
import {
  outstandingInvoicePageSchema,
  reportDownloadSchema,
  reportLimitsSchema,
  reportResultSchema,
  reportRunPageSchema,
  reportRunSchema,
} from './schemas';
import type {
  AgeBand,
  OutstandingInvoicePage,
  ReportDownload,
  ReportKind,
  ReportLimits,
  ReportResult,
  ReportRun,
  ReportRunPage,
} from './types';

// A report's days are in the body of a POST, so a filter never sits in an address. A report holds
// counts, money and catalog names, never a patient's record. The two requests a person waits on
// are sent once (`apiFetchOnce`): a refusal for a busy service or a used quota says how long to
// wait, and the person is told at once instead of after the client waited it out twice.

export interface ReportDays {
  from?: string;
  to?: string;
}

/** Works a report out now: at most 31 days, read from the replica under a time limit. */
export async function fetchReport(
  kind: ReportKind,
  body: ReportDays,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const result = await api.POST('/reports/{kind}', {
    params: { path: { kind } },
    body,
    signal,
    fetch: apiFetchOnce,
  });
  return reportResultSchema.parse(requireData(result));
}

/** Asks for a stored report. The API answers 202 with the run, `queued`. */
export async function requestRun(
  kind: ReportKind,
  body: ReportDays,
  idempotencyKey: string,
): Promise<ReportRun> {
  const result = await api.POST('/reports/{kind}/runs', {
    params: { path: { kind }, header: { 'idempotency-key': idempotencyKey } },
    body,
    fetch: apiFetchOnce,
  });
  return reportRunSchema.parse(requireData(result));
}

export async function fetchRuns(
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ReportRunPage> {
  const result = await api.GET('/reports/runs', { params: { query: { cursor, limit } }, signal });
  return reportRunPageSchema.parse(requireData(result));
}

/** One run with its result, once it has succeeded. */
export async function fetchRun(runId: string, signal?: AbortSignal): Promise<ReportRun> {
  const result = await api.GET('/reports/runs/{runId}', { params: { path: { runId } }, signal });
  return reportRunSchema.parse(requireData(result));
}

/** The invoices behind an age band of the outstanding report: numbers and amounts, no patient. */
export async function fetchOutstandingInvoices(
  band: AgeBand,
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<OutstandingInvoicePage> {
  const result = await api.POST('/reports/outstanding/invoices', {
    body: { band, cursor, limit },
    signal,
  });
  return outstandingInvoicePageSchema.parse(requireData(result));
}

export async function fetchLimits(signal?: AbortSignal): Promise<ReportLimits> {
  const result = await api.GET('/reports/limits', { signal });
  return reportLimitsSchema.parse(requireData(result));
}

/** A signed link that works for a few minutes. Asked for when it is used, never kept. */
export async function fetchDownloadUrl(runId: string): Promise<ReportDownload> {
  const result = await api.GET('/reports/runs/{runId}/download-url', {
    params: { path: { runId } },
  });
  return reportDownloadSchema.parse(requireData(result));
}
