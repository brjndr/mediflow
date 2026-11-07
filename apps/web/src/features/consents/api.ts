import { api, requireData } from '@/shared/api';
import {
  certificatePageSchema,
  certificateSchema,
  consentDetailSchema,
  consentPageSchema,
} from './schemas';
import type {
  Certificate,
  CertificateCreate,
  CertificatePage,
  ConsentCreate,
  ConsentDetail,
  ConsentPage,
} from './types';

// Addresses hold ids and a page cursor only: a procedure, a name or a diagnosis is never in a
// URL. Every POST carries an idempotency key. There is no update or delete of either record.

export async function fetchConsents(
  { patientId, cursor, limit }: { patientId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ConsentPage> {
  const result = await api.GET('/patients/{patientId}/consents', {
    params: { path: { patientId }, query: { cursor, limit } },
    signal,
  });
  return consentPageSchema.parse(requireData(result));
}

export async function fetchConsent(
  consentId: string,
  signal?: AbortSignal,
): Promise<ConsentDetail> {
  const result = await api.GET('/consents/{consentId}', {
    params: { path: { consentId } },
    signal,
  });
  return consentDetailSchema.parse(requireData(result));
}

export async function signConsent(
  patientId: string,
  body: ConsentCreate,
  idempotencyKey: string,
): Promise<ConsentDetail> {
  const result = await api.POST('/patients/{patientId}/consents', {
    params: { path: { patientId }, header: { 'idempotency-key': idempotencyKey } },
    body: { ...body, body: { ...body.body } },
  });
  return consentDetailSchema.parse(requireData(result));
}

export async function fetchCertificates(
  { patientId, cursor, limit }: { patientId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CertificatePage> {
  const result = await api.GET('/patients/{patientId}/certificates', {
    params: { path: { patientId }, query: { cursor, limit } },
    signal,
  });
  return certificatePageSchema.parse(requireData(result));
}

export async function issueCertificate(
  patientId: string,
  body: CertificateCreate,
  idempotencyKey: string,
): Promise<Certificate> {
  const result = await api.POST('/patients/{patientId}/certificates', {
    params: { path: { patientId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return certificateSchema.parse(requireData(result));
}
