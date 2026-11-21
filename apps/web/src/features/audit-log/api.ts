import { api, apiFetchOnce, requireData } from '@/shared/api';
import { auditPageSchema, downloadSchema, exportRunSchema } from './schemas';
import type { AuditPage, ReportRun } from './types';

// The filters are in the body of a POST, so a record id never sits in an address. An entry holds
// record ids and an account's name, never a patient's name.

export interface AuditFilters {
  from: string;
  to: string;
  actorId?: string;
  entity?: string;
  entityId?: string;
  action?: string;
}

export async function searchAudit(
  filters: AuditFilters,
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<AuditPage> {
  const result = await api.POST('/audit/search', {
    body: { ...filters, cursor, limit },
    signal,
  });
  return auditPageSchema.parse(requireData(result));
}

/** Asks for the audit log of a range of days as a stored report with a CSV file. */
export async function requestExport(
  body: { from: string; to: string },
  idempotencyKey: string,
): Promise<ReportRun> {
  const result = await api.POST('/reports/{kind}/runs', {
    params: { path: { kind: 'audit_log' }, header: { 'idempotency-key': idempotencyKey } },
    body,
    fetch: apiFetchOnce,
  });
  return exportRunSchema.parse(requireData(result));
}

export async function fetchExport(runId: string, signal?: AbortSignal): Promise<ReportRun> {
  const result = await api.GET('/reports/runs/{runId}', { params: { path: { runId } }, signal });
  return exportRunSchema.parse(requireData(result));
}

/** A signed link that works for a few minutes. Asked for when it is used, never kept. */
export async function fetchExportLink(runId: string) {
  const result = await api.GET('/reports/runs/{runId}/download-url', {
    params: { path: { runId } },
  });
  return downloadSchema.parse(requireData(result));
}
