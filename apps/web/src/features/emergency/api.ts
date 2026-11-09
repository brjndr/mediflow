import { api, requireData } from '@/shared/api';
import { caseSchema, casePageSchema } from './schemas';
import type {
  EmergencyCase,
  EmergencyCaseCreate,
  EmergencyCasePage,
  EmergencyCaseStatus,
} from './types';

// Every address holds ids only: nothing about the patient is in a URL.

export async function fetchCases(
  { status, cursor, limit }: { status?: EmergencyCaseStatus; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<EmergencyCasePage> {
  const result = await api.GET('/emergency/cases', {
    params: { query: { status, cursor, limit } },
    signal,
  });
  return casePageSchema.parse(requireData(result));
}

export async function registerCase(body: EmergencyCaseCreate, key: string): Promise<EmergencyCase> {
  const result = await api.POST('/emergency/cases', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return caseSchema.parse(requireData(result));
}

export async function triageCase(
  { row, category }: { row: EmergencyCase; category: number },
  key: string,
): Promise<EmergencyCase> {
  const result = await api.POST('/emergency/cases/{caseId}/triage', {
    params: { path: { caseId: row.id }, header: { 'idempotency-key': key } },
    body: { category, version: row.version },
  });
  return caseSchema.parse(requireData(result));
}

export async function identifyCase(
  { row, patientId }: { row: EmergencyCase; patientId: string },
  key: string,
): Promise<EmergencyCase> {
  const result = await api.POST('/emergency/cases/{caseId}/identify', {
    params: { path: { caseId: row.id }, header: { 'idempotency-key': key } },
    body: { patientId, version: row.version },
  });
  return caseSchema.parse(requireData(result));
}
