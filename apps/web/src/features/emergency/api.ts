import { api, requireData } from '@/shared/api';
import { casePageSchema, caseSchema, mlcSchema, notePageSchema, noteSchema } from './schemas';
import type {
  EmergencyCase,
  EmergencyCaseCreate,
  EmergencyCasePage,
  EmergencyCaseStatus,
  EmergencyDisposition,
  EmergencyMlc,
  EmergencyMlcSave,
  EmergencyNote,
  EmergencyNoteKind,
  EmergencyNotePage,
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

export async function fetchCase(caseId: string, signal?: AbortSignal): Promise<EmergencyCase> {
  const result = await api.GET('/emergency/cases/{caseId}', {
    params: { path: { caseId } },
    signal,
  });
  return caseSchema.parse(requireData(result));
}

export async function startTreatment(row: EmergencyCase, key: string): Promise<EmergencyCase> {
  const result = await api.POST('/emergency/cases/{caseId}/start', {
    params: { path: { caseId: row.id }, header: { 'idempotency-key': key } },
    body: { version: row.version },
  });
  return caseSchema.parse(requireData(result));
}

/** Opens the emergency encounter the case's orders are placed on. */
export async function openEncounter(row: EmergencyCase, key: string): Promise<EmergencyCase> {
  const result = await api.POST('/emergency/cases/{caseId}/encounter', {
    params: { path: { caseId: row.id }, header: { 'idempotency-key': key } },
    body: { version: row.version },
  });
  return caseSchema.parse(requireData(result));
}

export async function fetchNotes(
  { caseId, cursor, limit }: { caseId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<EmergencyNotePage> {
  const result = await api.GET('/emergency/cases/{caseId}/notes', {
    params: { path: { caseId }, query: { cursor, limit } },
    signal,
  });
  return notePageSchema.parse(requireData(result));
}

export async function addNote(
  { caseId, kind, body }: { caseId: string; kind: EmergencyNoteKind; body: string },
  key: string,
): Promise<EmergencyNote> {
  const result = await api.POST('/emergency/cases/{caseId}/notes', {
    params: { path: { caseId }, header: { 'idempotency-key': key } },
    body: { kind, body },
  });
  return noteSchema.parse(requireData(result));
}

export async function disposeCase(
  { row, ...body }: { row: EmergencyCase } & Omit<EmergencyDisposition, 'version'>,
  key: string,
): Promise<EmergencyCase> {
  const result = await api.POST('/emergency/cases/{caseId}/disposition', {
    params: { path: { caseId: row.id }, header: { 'idempotency-key': key } },
    body: { ...body, version: row.version },
  });
  return caseSchema.parse(requireData(result));
}

/** The medico-legal record of a case; every view is audited on the server. */
export async function fetchMlc(caseId: string, signal?: AbortSignal): Promise<EmergencyMlc> {
  const result = await api.GET('/emergency/cases/{caseId}/medico-legal', {
    params: { path: { caseId } },
    signal,
  });
  return mlcSchema.parse(requireData(result));
}

/** Flags the case (revision 0) or revises the record: each save is a new revision. */
export async function saveMlc(
  { caseId, ...body }: { caseId: string } & EmergencyMlcSave,
  key: string,
): Promise<EmergencyMlc> {
  const result = await api.PUT('/emergency/cases/{caseId}/medico-legal', {
    params: { path: { caseId }, header: { 'idempotency-key': key } },
    body,
  });
  return mlcSchema.parse(requireData(result));
}
