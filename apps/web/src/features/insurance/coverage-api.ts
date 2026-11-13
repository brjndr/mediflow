import { api, requireData } from '@/shared/api';
import {
  policyListSchema,
  policySchema,
  preAuthListSchema,
  preAuthSchema,
} from './coverage-schemas';
import type {
  PatientPolicy,
  PatientPolicyCreate,
  PreAuth,
  PreAuthCreate,
  PreAuthDecision,
} from './types';

// Every address holds ids only; a policy number travels in the body.

export async function fetchPolicies(
  patientId: string,
  signal?: AbortSignal,
): Promise<PatientPolicy[]> {
  const result = await api.GET('/patients/{patientId}/policies', {
    params: { path: { patientId } },
    signal,
  });
  return policyListSchema.parse(requireData(result));
}

export async function createPolicy(
  patientId: string,
  body: PatientPolicyCreate,
  key: string,
): Promise<PatientPolicy> {
  const result = await api.POST('/patients/{patientId}/policies', {
    params: { path: { patientId }, header: { 'idempotency-key': key } },
    body,
  });
  return policySchema.parse(requireData(result));
}

export async function endPolicy(policyId: string, version: number): Promise<PatientPolicy> {
  const result = await api.POST('/patient-policies/{policyId}/end', {
    params: { path: { policyId } },
    body: { version },
  });
  return policySchema.parse(requireData(result));
}

export async function fetchPatientPreAuths(
  patientId: string,
  signal?: AbortSignal,
): Promise<PreAuth[]> {
  const result = await api.GET('/patients/{patientId}/pre-auths', {
    params: { path: { patientId } },
    signal,
  });
  return preAuthListSchema.parse(requireData(result));
}

export async function fetchEncounterPreAuths(
  encounterId: string,
  signal?: AbortSignal,
): Promise<PreAuth[]> {
  const result = await api.GET('/encounters/{encounterId}/pre-auths', {
    params: { path: { encounterId } },
    signal,
  });
  return preAuthListSchema.parse(requireData(result));
}

export async function createPreAuth(
  patientId: string,
  body: PreAuthCreate,
  key: string,
): Promise<PreAuth> {
  const result = await api.POST('/patients/{patientId}/pre-auths', {
    params: { path: { patientId }, header: { 'idempotency-key': key } },
    body,
  });
  return preAuthSchema.parse(requireData(result));
}

export async function decidePreAuth(preAuthId: string, body: PreAuthDecision): Promise<PreAuth> {
  const result = await api.POST('/pre-auths/{preAuthId}/decision', {
    params: { path: { preAuthId } },
    body,
  });
  return preAuthSchema.parse(requireData(result));
}

export async function cancelPreAuth(preAuthId: string, version: number): Promise<PreAuth> {
  const result = await api.POST('/pre-auths/{preAuthId}/cancel', {
    params: { path: { preAuthId } },
    body: { version },
  });
  return preAuthSchema.parse(requireData(result));
}
