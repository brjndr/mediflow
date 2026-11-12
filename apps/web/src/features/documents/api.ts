import { api, requireData } from '@/shared/api';
import { env } from '@/shared/config/env';
import {
  documentPageSchema,
  documentSchema,
  holdPageSchema,
  holdSchema,
  downloadSchema,
  retentionRulesSchema,
  retentionSetSchema,
  uploadSchema,
} from './schemas';
import type {
  DocumentCategory,
  LegalHold,
  LegalHoldPage,
  PatientDocument,
  PatientDocumentCreate,
  PatientDocumentPage,
  PatientDocumentUpload,
  RetentionRule,
} from './types';

// Every address holds ids, a category and a page cursor only: a title, a file name or anything
// else about the patient is never in a URL. Every POST carries an idempotency key.

export interface DocumentFilters {
  category: DocumentCategory | '';
  includeRetired: boolean;
}

export async function fetchDocuments(
  {
    patientId,
    category,
    includeRetired,
    cursor,
    limit,
  }: DocumentFilters & { patientId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<PatientDocumentPage> {
  const result = await api.GET('/patients/{patientId}/documents', {
    params: {
      path: { patientId },
      query: {
        category: category || undefined,
        includeRetired: includeRetired || undefined,
        cursor,
        limit,
      },
    },
    signal,
  });
  return documentPageSchema.parse(requireData(result));
}

/** Asks to attach a file: the answer holds the signed address the file itself goes to. */
export async function requestUpload(
  patientId: string,
  body: PatientDocumentCreate,
  idempotencyKey: string,
): Promise<PatientDocumentUpload> {
  const result = await api.POST('/patients/{patientId}/documents', {
    params: { path: { patientId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return uploadSchema.parse(requireData(result));
}

/**
 * Sends the bytes to the signed address (valid once, no session needed: the signature is the
 * credential). The address is the API's own, so it is put after the API base.
 */
export async function sendFile(uploadUrl: string, file: File): Promise<void> {
  const base = new URL(env.apiBaseUrl, window.location.origin).href.replace(/\/$/, '');
  const response = await fetch(`${base}${uploadUrl}`, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!response.ok) throw new UploadRefused(response.status);
}

/** The file was refused on its way in; the status says why (413, 415, 400). */
export class UploadRefused extends Error {
  constructor(readonly status: number) {
    super('upload_refused');
  }
}

/** A signed, short-lived link to a scanned file. Asking for it is audited as an export. */
export async function fetchDownloadUrl(documentId: string): Promise<string> {
  const result = await api.GET('/documents/{documentId}/download-url', {
    params: { path: { documentId } },
  });
  const { url } = downloadSchema.parse(requireData(result));
  const base = new URL(env.apiBaseUrl, window.location.origin).href.replace(/\/$/, '');
  return `${base}${url}`;
}

export async function retireDocument(
  documentId: string,
  body: { reason: string; expectedVersion: number },
): Promise<PatientDocument> {
  const result = await api.POST('/documents/{documentId}/retire', {
    params: { path: { documentId } },
    body,
  });
  return documentSchema.parse(requireData(result));
}

/** The years each category is kept (#561): every category, `years` null where kept for ever. */
export async function fetchRetentionRules(signal?: AbortSignal): Promise<RetentionRule[]> {
  const result = await api.GET('/document-retention', { signal });
  return retentionRulesSchema.parse(requireData(result)).items;
}

/** Sets the years a category is kept from now on, or null to keep it for ever. */
export async function setRetention(
  category: DocumentCategory,
  years: number | null,
): Promise<RetentionRule> {
  const result = await api.PUT('/document-retention/{category}', {
    params: { path: { category } },
    body: { years },
  });
  return retentionSetSchema.parse(requireData(result));
}

/** Places a hold on one document, or on every document of a patient (`documentId` absent). */
export async function placeHold(
  target: { patientId: string; documentId?: string },
  reason: string,
): Promise<LegalHold> {
  const result = target.documentId
    ? await api.POST('/documents/{documentId}/legal-hold', {
        params: { path: { documentId: target.documentId } },
        body: { reason },
      })
    : await api.POST('/patients/{patientId}/legal-hold', {
        params: { path: { patientId: target.patientId } },
        body: { reason },
      });
  return holdSchema.parse(requireData(result));
}

/** The active holds of the hospital, newest first. */
export async function fetchHolds(
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<LegalHoldPage> {
  const result = await api.GET('/legal-holds', { params: { query: { cursor, limit } }, signal });
  return holdPageSchema.parse(requireData(result));
}

export async function releaseHold(holdId: string): Promise<LegalHold> {
  const result = await api.POST('/legal-holds/{holdId}/release', {
    params: { path: { holdId } },
  });
  return holdSchema.parse(requireData(result));
}
