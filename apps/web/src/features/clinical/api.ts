import { api, requireData } from '@/shared/api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import {
  diagnosisPageSchema,
  diagnosisSchema,
  encounterPageSchema,
  encounterSchema,
  notePageSchema,
  noteSchema,
} from './schemas';
import type {
  ClinicalNote,
  ClinicalNotePage,
  Diagnosis,
  DiagnosisCreate,
  DiagnosisPage,
  Encounter,
  EncounterCreate,
  EncounterPage,
  EncounterStatus,
} from './types';

// Every address holds ids only: nothing about the patient is in a URL. Every POST carries an
// idempotency key, which the API requires; saving and discarding a draft go by its version.

export interface EncounterFilters {
  attendingDoctorId: string;
  status: EncounterStatus | '';
}

export async function fetchEncounters(
  {
    attendingDoctorId,
    status,
    cursor,
    limit,
  }: EncounterFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<EncounterPage> {
  const result = await api.GET('/encounters', {
    params: {
      query: {
        attendingDoctorId: attendingDoctorId || undefined,
        status: status || undefined,
        cursor,
        limit,
      },
    },
    signal,
  });
  return encounterPageSchema.parse(requireData(result));
}

export async function fetchEncounter(
  encounterId: string,
  signal?: AbortSignal,
): Promise<Encounter> {
  const result = await api.GET('/encounters/{encounterId}', {
    params: { path: { encounterId } },
    signal,
  });
  return encounterSchema.parse(requireData(result));
}

/**
 * Opens the consultation from a token or an appointment. The answer is the encounter, whether it
 * was opened now (201) or was already open for that token or appointment (200).
 */
export async function openEncounter(
  body: EncounterCreate,
  idempotencyKey: string,
): Promise<Encounter> {
  const result = await api.POST('/encounters', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return encounterSchema.parse(requireData(result));
}

export async function closeEncounter(
  encounterId: string,
  version: number,
  idempotencyKey: string,
): Promise<Encounter> {
  const result = await api.POST('/encounters/{encounterId}/close', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return encounterSchema.parse(requireData(result));
}

export async function cancelEncounter(
  encounterId: string,
  body: { version: number; reason: string },
  idempotencyKey: string,
): Promise<Encounter> {
  const result = await api.POST('/encounters/{encounterId}/cancel', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return encounterSchema.parse(requireData(result));
}

/** The signed notes, amendments included, and the caller's own drafts, oldest first. */
export async function fetchNotes(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ClinicalNotePage> {
  const result = await api.GET('/encounters/{encounterId}/notes', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return notePageSchema.parse(requireData(result));
}

export async function fetchNote(noteId: string, signal?: AbortSignal): Promise<ClinicalNote> {
  const result = await api.GET('/notes/{noteId}', { params: { path: { noteId } }, signal });
  return noteSchema.parse(requireData(result));
}

/** Starts a draft on the server. A draft is never kept in the browser. */
export async function createNote(
  encounterId: string,
  body: RichTextDocument,
  idempotencyKey: string,
): Promise<ClinicalNote> {
  const result = await api.POST('/encounters/{encounterId}/notes', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body: { body: { ...body } },
  });
  return noteSchema.parse(requireData(result));
}

/** Saves the draft whole, from the version the edit started from: another one is 409. */
export async function saveNote(
  noteId: string,
  body: RichTextDocument,
  version: number,
): Promise<ClinicalNote> {
  const result = await api.PATCH('/notes/{noteId}', {
    params: { path: { noteId } },
    body: { body: { ...body }, version },
  });
  return noteSchema.parse(requireData(result));
}

export async function discardNote(noteId: string): Promise<void> {
  // A refusal is thrown by the client; a 204 has no body to read.
  await api.DELETE('/notes/{noteId}', { params: { path: { noteId } } });
}

export async function signNote(
  noteId: string,
  version: number,
  idempotencyKey: string,
): Promise<ClinicalNote> {
  const result = await api.POST('/notes/{noteId}/sign', {
    params: { path: { noteId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return noteSchema.parse(requireData(result));
}

/** A new signed note with the whole corrected text, naming the note it amends. */
export async function amendNote(
  noteId: string,
  body: { body: RichTextDocument; reason: string },
  idempotencyKey: string,
): Promise<ClinicalNote> {
  const result = await api.POST('/notes/{noteId}/amendments', {
    params: { path: { noteId }, header: { 'idempotency-key': idempotencyKey } },
    body: { body: { ...body.body }, reason: body.reason },
  });
  return noteSchema.parse(requireData(result));
}

export async function fetchDiagnoses(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<DiagnosisPage> {
  const result = await api.GET('/encounters/{encounterId}/diagnoses', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return diagnosisPageSchema.parse(requireData(result));
}

export async function recordDiagnosis(
  encounterId: string,
  body: DiagnosisCreate,
  idempotencyKey: string,
): Promise<Diagnosis> {
  const result = await api.POST('/encounters/{encounterId}/diagnoses', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return diagnosisSchema.parse(requireData(result));
}

export async function retractDiagnosis(
  diagnosisId: string,
  reason: string,
  idempotencyKey: string,
): Promise<Diagnosis> {
  const result = await api.POST('/diagnoses/{diagnosisId}/retract', {
    params: { path: { diagnosisId }, header: { 'idempotency-key': idempotencyKey } },
    body: { reason },
  });
  return diagnosisSchema.parse(requireData(result));
}
