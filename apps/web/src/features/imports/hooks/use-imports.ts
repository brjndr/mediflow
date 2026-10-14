import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { sessionKey, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  actOnBatch,
  addRows,
  createBatch,
  fetchBatch,
  fetchBatches,
  fetchKinds,
  fetchProblems,
} from '../api';
import type { ReadFile } from '../read-file';
import { CHUNK_ROWS, WORKING, type Mapping } from '../schemas';
import type { ImportBatch } from '../types';

/** Every key is prefixed with the tenant, so one hospital's batches never show in another. */
export const importKeys = createTenantKeys('imports');
const kindKeys = createTenantKeys('import-kinds');
const problemKeys = createTenantKeys('import-problems');

export const IMPORTS_PAGE_SIZE = 25;
export const PROBLEMS_PAGE_SIZE = 50;

/** How often a batch a job is working on is asked about: soon at first, then less often. */
const FIRST_POLL_MS = 1_000;
const LONGEST_POLL_MS = 5_000;
export const pollDelay = (polls: number): number =>
  Math.min(FIRST_POLL_MS * 1.5 ** polls, LONGEST_POLL_MS);

export function useImportKinds() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: kindKeys.all(tenantId ?? ''),
    queryFn: ({ signal }) => fetchKinds(signal),
    enabled: tenantId !== undefined,
    // What may be loaded changes with the policy, which is rare.
    staleTime: 60_000,
  });
}

export function useImportBatches() {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: importKeys.list(tenantId ?? '', { limit: IMPORTS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchBatches({ cursor: pageParam, limit: IMPORTS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
  });
}

/** A batch, followed while a job works on it, asked about less often the longer it takes. */
export function useImportBatch(batchId: string) {
  const tenantId = useTenant()?.id;
  const polls = useRef(0);
  return useQuery({
    queryKey: importKeys.detail(tenantId ?? '', batchId),
    queryFn: ({ signal }) => fetchBatch(batchId, signal),
    enabled: tenantId !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined || !WORKING.includes(status)) {
        polls.current = 0;
        return false;
      }
      return pollDelay(polls.current++);
    },
  });
}

/** The report of a batch, a page at a time. Read again whenever the batch's job ends. */
export function useImportProblems(batch: ImportBatch | undefined) {
  const tenantId = useTenant()?.id;
  const batchId = batch?.id ?? '';
  return useInfiniteQuery({
    // The report changes only when a job ends: a new key then, and none while it works.
    queryKey: problemKeys.list(tenantId ?? '', {
      batchId,
      checkedAt: batch?.checkedAt ?? '',
      finishedAt: batch?.finishedAt ?? '',
    }),
    queryFn: ({ pageParam, signal }) =>
      fetchProblems(batchId, { cursor: pageParam, limit: PROBLEMS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled:
      tenantId !== undefined &&
      batch !== undefined &&
      batch.problemCount > 0 &&
      !WORKING.includes(batch.status),
  });
}

/** Writes the answer into the cache, unless the session moved on before it came. */
function useStoreBatch() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return (batch: ImportBatch) => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    if (!tenantId || session?.activeTenant?.id !== tenantId) return;
    queryClient.setQueryData(importKeys.detail(tenantId, batch.id), batch);
    void queryClient.invalidateQueries({ queryKey: importKeys.lists(tenantId) });
  };
}

export function useBatchAction(batchId: string) {
  const store = useStoreBatch();
  return useMutation({
    mutationFn: (action: 'check' | 'commit' | 'cancel') => actOnBatch(batchId, action),
    onSuccess: store,
  });
}

/** Well under the API's limit on the size of a request body (1 MiB). */
const CHUNK_BYTES = 800_000;
const encoder = new TextEncoder();

/**
 * The rows in chunks the API takes: at most `CHUNK_ROWS` rows and about `CHUNK_BYTES` of JSON,
 * since a row of long text in an Indic script takes three bytes a letter.
 */
export function chunksOf<Row>(rows: readonly Row[]): Row[][] {
  const chunks: Row[][] = [];
  let chunk: Row[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1;
    if (chunk.length > 0 && (chunk.length >= CHUNK_ROWS || bytes + size > CHUNK_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export interface UploadProgress {
  sent: number;
  total: number;
}

/**
 * Starts a batch and sends the mapped rows of a file to it, a chunk at a time, then asks for the
 * dry run. Sending belongs to this screen at this hospital: it stops if the screen is left or the
 * hospital changes, and what was sent waits as a staged batch, which can be given up.
 */
export function useUploadBatch() {
  const store = useStoreBatch();
  const tenantId = useTenant()?.id;
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const live = useRef({ mounted: true, tenantId, abort: new AbortController() });
  useEffect(() => {
    const current = { mounted: true, tenantId, abort: new AbortController() };
    live.current = current;
    return () => {
      current.mounted = false;
      // A request on its way stops too, not only the next one.
      current.abort.abort();
    };
  }, [tenantId]);

  const mutation = useMutation({
    mutationFn: async ({
      kind,
      file,
      mapping,
    }: {
      kind: string;
      file: ReadFile;
      mapping: Mapping;
    }): Promise<ImportBatch> => {
      const startedFor = live.current;
      const here = () => live.current === startedFor && startedFor.mounted;
      const chosen = Object.entries(mapping).filter(([, column]) => column !== '');
      const fields = chosen.map(([field]) => field);
      const at = chosen.map(([, column]) => Number(column));
      const total = file.rows.length;
      setProgress({ sent: 0, total });
      let batch = await createBatch(kind, crypto.randomUUID());
      const mapped = file.rows.map((row) => ({
        line: row.line,
        values: at.map((index) => row.fields[index] ?? ''),
      }));
      let sent = 0;
      for (const rows of chunksOf(mapped)) {
        if (!here()) throw new Error('left');
        try {
          batch = await addRows(batch.id, { fields, rows }, startedFor.abort.signal);
        } catch (error) {
          if (!here()) throw new Error('left', { cause: error });
          throw error;
        }
        sent += rows.length;
        if (here()) setProgress({ sent, total });
      }
      if (!here()) throw new Error('left');
      return actOnBatch(batch.id, 'check');
    },
    onSuccess: store,
    onSettled: () => {
      if (live.current.mounted) setProgress(null);
    },
  });
  return { ...mutation, progress };
}
