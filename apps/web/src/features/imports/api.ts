import { api, requireData } from '@/shared/api';
import { batchPageSchema, batchSchema, kindListSchema, problemPageSchema } from './schemas';
import type { ImportBatch, ImportBatchPage, ImportKind, ImportProblemPage } from './types';

export async function fetchKinds(signal?: AbortSignal): Promise<ImportKind[]> {
  const result = await api.GET('/imports/kinds', { signal });
  return kindListSchema.parse(requireData(result)).items;
}

export async function fetchBatches(
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ImportBatchPage> {
  const result = await api.GET('/imports', { params: { query: { cursor, limit } }, signal });
  return batchPageSchema.parse(requireData(result));
}

export async function fetchBatch(batchId: string, signal?: AbortSignal): Promise<ImportBatch> {
  const result = await api.GET('/imports/{batchId}', { params: { path: { batchId } }, signal });
  return batchSchema.parse(requireData(result));
}

export async function fetchProblems(
  batchId: string,
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ImportProblemPage> {
  const result = await api.GET('/imports/{batchId}/problems', {
    params: { path: { batchId }, query: { cursor, limit } },
    signal,
  });
  return problemPageSchema.parse(requireData(result));
}

/** Starts a batch. The key makes a repeat of the request start one batch, not two. */
export async function createBatch(kind: string, idempotencyKey: string): Promise<ImportBatch> {
  const result = await api.POST('/imports', {
    body: { kind },
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return batchSchema.parse(requireData(result));
}

/**
 * Sends rows of the file. A line the batch already has is kept as it was, so sending a chunk
 * again after a lost answer adds nothing.
 */
export async function addRows(
  batchId: string,
  body: { fields: string[]; rows: { line: number; values: string[] }[] },
  signal?: AbortSignal,
): Promise<ImportBatch> {
  const result = await api.POST('/imports/{batchId}/rows', {
    params: { path: { batchId } },
    body,
    signal,
  });
  return batchSchema.parse(requireData(result));
}

export async function actOnBatch(
  batchId: string,
  action: 'check' | 'commit' | 'cancel',
): Promise<ImportBatch> {
  const params = { path: { batchId } };
  const result =
    action === 'check'
      ? await api.POST('/imports/{batchId}/check', { params })
      : action === 'commit'
        ? await api.POST('/imports/{batchId}/commit', { params })
        : await api.POST('/imports/{batchId}/cancel', { params });
  return batchSchema.parse(requireData(result));
}
