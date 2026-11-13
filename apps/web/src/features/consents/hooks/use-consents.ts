import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  fetchCertificateFormats,
  fetchCertificates,
  fetchConsent,
  fetchConsents,
  issueCertificate,
  resetCertificateFormat,
  setCertificateFormat,
  signConsent,
} from '../api';
import { CONSENTS_PAGE_SIZE } from '../schemas';
import type {
  CertificateCreate,
  CertificateFormatUpdate,
  CertificateKind,
  ConsentCreate,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's consents never show in another. */
export const consentKeys = createTenantKeys('consents');
export const certificateKeys = createTenantKeys('certificates');
export const formatKeys = createTenantKeys('certificate-formats');

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
 */
function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  };
}

export function usePatientConsents(patientId: string, { enabled }: { enabled: boolean }) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: consentKeys.list(tenantId ?? '', { patientId, limit: CONSENTS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchConsents({ patientId, cursor: pageParam, limit: CONSENTS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: enabled && tenantId !== undefined && patientId !== '',
  });
}

/** One signed consent with its text. It never changes, so what was read stays good. */
export function useConsent(consentId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: consentKeys.detail(tenantId ?? '', consentId),
    queryFn: ({ signal }) => fetchConsent(consentId, signal),
    enabled: tenantId !== undefined && consentId !== '',
    staleTime: Infinity,
  });
}

export function usePatientCertificates(patientId: string, { enabled }: { enabled: boolean }) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: certificateKeys.list(tenantId ?? '', { patientId, limit: CONSENTS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchCertificates({ patientId, cursor: pageParam, limit: CONSENTS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: enabled && tenantId !== undefined && patientId !== '',
  });
}

/**
 * One key for one identical body, so a second tap after a slow answer is the same request and
 * never a second signed consent.
 */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    keyFor: (body: unknown) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    done: () => {
      attempt.current = undefined;
    },
  };
}

export function useSignConsent(patientId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: ConsentCreate) => {
      const signed = await signConsent(patientId, body, attempt.keyFor(body));
      attempt.done();
      return signed;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) return queryClient.invalidateQueries({ queryKey: consentKeys.all(tenantId) });
    },
  });
}

export function useIssueCertificate(patientId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: CertificateCreate) => {
      const issued = await issueCertificate(patientId, body, attempt.keyFor(body));
      attempt.done();
      return issued;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: certificateKeys.all(tenantId) });
      }
    },
  });
}

/** The fields of each kind of certificate in this hospital: at most four items, one read. */
export function useCertificateFormats() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: formatKeys.list(tenantId ?? '', {}),
    queryFn: ({ signal }) => fetchCertificateFormats(signal),
    enabled: tenantId !== undefined,
  });
}

/** Saves the fields of a kind, or with `fields` absent goes back to the standard ones. */
export function useSetCertificateFormat() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: ({
      kind,
      update,
    }: {
      kind: CertificateKind;
      update: CertificateFormatUpdate | null;
    }) => (update ? setCertificateFormat(kind, update) : resetCertificateFormat(kind)),
    // The key holds the hospital it was made for, so this is harmless after a switch.
    onSettled: () =>
      tenantId === undefined
        ? undefined
        : queryClient.invalidateQueries({ queryKey: formatKeys.all(tenantId) }),
  });
}
