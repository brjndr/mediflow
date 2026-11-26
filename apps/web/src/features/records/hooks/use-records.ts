import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  assignIncompleteRecord,
  closeRecordRequest,
  codeDiagnosis,
  createRecordRequest,
  decideCorrection,
  fetchCodingQueue,
  fetchCorrectionAmendments,
  fetchCorrectionRequests,
  fetchIncompleteRecords,
  fetchRecordRequests,
  requestCorrection,
} from '../api';
import { RECORDS_PAGE_SIZE } from '../schemas';
import type {
  CodingState,
  CorrectionRequestCreate,
  CorrectionRequestDecide,
  CorrectionStatus,
  CorrectionTarget,
  EncounterKind,
  IncompleteRecordAssign,
  RecordGap,
  RecordRequestClose,
  RecordRequestCreate,
  RecordRequestState,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's lists never show in another. */
export const recordKeys = createTenantKeys('records');
export const codingKeys = createTenantKeys('record_coding');
export const requestKeys = createTenantKeys('record_requests');

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

/** One key for one identical body: a second tap after a slow answer is the same request. */
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

export function useIncompleteRecords(
  filters: { gap: RecordGap | ''; kind: EncounterKind | '' },
  limit = RECORDS_PAGE_SIZE,
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: recordKeys.list(tenantId ?? '', { ...filters, limit }),
    queryFn: ({ pageParam, signal }) =>
      fetchIncompleteRecords({ ...filters, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

export function useAssignRecord(encounterId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: IncompleteRecordAssign) => {
      const assigned = await assignIncompleteRecord(encounterId, body, attempt.keyFor(body));
      attempt.done();
      return assigned;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) return queryClient.invalidateQueries({ queryKey: recordKeys.all(tenantId) });
    },
  });
}

export function useCodingQueue(state: CodingState) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: codingKeys.list(tenantId ?? '', { state, limit: RECORDS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchCodingQueue({ state, cursor: pageParam, limit: RECORDS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

export function useCodeDiagnosis(diagnosisId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: { codeId: string; version: number }) => {
      const coded = await codeDiagnosis(diagnosisId, body, attempt.keyFor(body));
      attempt.done();
      return coded;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) return queryClient.invalidateQueries({ queryKey: codingKeys.all(tenantId) });
    },
  });
}

export function useRecordRequests(
  state: RecordRequestState | '',
  patientId?: string,
  limit = RECORDS_PAGE_SIZE,
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: requestKeys.list(tenantId ?? '', { state, patientId, limit }),
    queryFn: ({ pageParam, signal }) =>
      fetchRecordRequests({ state, patientId, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

export function useCreateRecordRequest() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: RecordRequestCreate) => {
      const created = await createRecordRequest(body, attempt.keyFor(body));
      attempt.done();
      return created;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) return queryClient.invalidateQueries({ queryKey: requestKeys.all(tenantId) });
    },
  });
}

export function useCloseRecordRequest(requestId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: RecordRequestClose) => {
      const closed = await closeRecordRequest(requestId, body, attempt.keyFor(body));
      attempt.done();
      return closed;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) return queryClient.invalidateQueries({ queryKey: requestKeys.all(tenantId) });
    },
  });
}

export const correctionKeys = createTenantKeys('record_corrections');

/** The hospital's requests (`correction:read` with scope all), or one patient's when given. */
export function useCorrectionRequests(
  status: CorrectionStatus | '',
  patientId?: string,
  limit = RECORDS_PAGE_SIZE,
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: correctionKeys.list(tenantId ?? '', { status, patientId, limit }),
    queryFn: ({ pageParam, signal }) =>
      fetchCorrectionRequests({ status, patientId, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

/** The amendments of one patient's record, or of one visit or document of it. */
export function useCorrectionAmendments(
  patientId: string,
  target?: { kind: CorrectionTarget; id?: string },
  limit = RECORDS_PAGE_SIZE,
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: correctionKeys.list(tenantId ?? '', { amendments: true, patientId, target, limit }),
    queryFn: ({ pageParam, signal }) =>
      fetchCorrectionAmendments({ patientId, target, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && patientId !== '',
  });
}

export function useRequestCorrection(patientId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useAttempt();
  return useMutation({
    mutationFn: async (body: CorrectionRequestCreate) => {
      const created = await requestCorrection(patientId, body, attempt.keyFor(body));
      attempt.done();
      return created;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId)
        return queryClient.invalidateQueries({ queryKey: correctionKeys.all(tenantId) });
    },
  });
}

/** Approve or reject at the version read; a decision is final, so there is no key to keep. */
export function useDecideCorrection(requestId: string, decision: 'approve' | 'reject') {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return useMutation({
    mutationFn: (body: CorrectionRequestDecide) => decideCorrection(requestId, decision, body),
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId)
        return queryClient.invalidateQueries({ queryKey: correctionKeys.all(tenantId) });
    },
  });
}
