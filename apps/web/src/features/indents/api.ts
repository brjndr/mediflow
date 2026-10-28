import { api, requireData } from '@/shared/api';
import { indentPageSchema, indentSchema, placePageSchema } from './schemas';
import type {
  IndentPlacePage,
  StockIndent,
  StockIndentCreate,
  StockIndentPage,
  StockIndentStatus,
  StockIssueCreate,
} from './types';

// Every address holds ids or a status: nothing about a patient, so these are GETs. Every POST
// carries an idempotency key.

const idempotent = (key: string) => ({ header: { 'idempotency-key': key } });

export async function fetchPlaces(
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<IndentPlacePage> {
  const result = await api.GET('/inventory/indent-places', {
    params: { query: { cursor, limit } },
    signal,
  });
  return placePageSchema.parse(requireData(result));
}

export async function fetchIndents(
  {
    status,
    locationId,
    cursor,
    limit,
  }: { status: StockIndentStatus | ''; locationId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<StockIndentPage> {
  const result = await api.GET('/inventory/indents', {
    params: {
      query: { status: status || undefined, locationId: locationId || undefined, cursor, limit },
    },
    signal,
  });
  return indentPageSchema.parse(requireData(result));
}

export async function fetchIndent(indentId: string, signal?: AbortSignal): Promise<StockIndent> {
  const result = await api.GET('/inventory/indents/{indentId}', {
    params: { path: { indentId } },
    signal,
  });
  return indentSchema.parse(requireData(result));
}

export async function createIndent(body: StockIndentCreate, key: string): Promise<StockIndent> {
  const result = await api.POST('/inventory/indents', { body, params: idempotent(key) });
  return indentSchema.parse(requireData(result));
}

export type IndentStep =
  | { step: 'approve'; lines: { lineId: string; quantity: number }[] }
  | { step: 'reject' | 'close'; note: string }
  | { step: 'cancel' };

export async function stepIndent(
  indentId: string,
  expectedVersion: number,
  change: IndentStep,
  key: string,
): Promise<StockIndent> {
  const params = { path: { indentId }, ...idempotent(key) };
  const result =
    change.step === 'approve'
      ? await api.POST('/inventory/indents/{indentId}/approve', {
          body: { expectedVersion, lines: change.lines },
          params,
        })
      : change.step === 'reject'
        ? await api.POST('/inventory/indents/{indentId}/reject', {
            body: { expectedVersion, note: change.note },
            params,
          })
        : change.step === 'close'
          ? await api.POST('/inventory/indents/{indentId}/close', {
              body: { expectedVersion, note: change.note },
              params,
            })
          : await api.POST('/inventory/indents/{indentId}/cancel', {
              body: { expectedVersion },
              params,
            });
  return indentSchema.parse(requireData(result));
}

export async function issueIndent(
  indentId: string,
  body: StockIssueCreate,
  key: string,
): Promise<StockIndent> {
  const result = await api.POST('/inventory/indents/{indentId}/issues', {
    body,
    params: { path: { indentId }, ...idempotent(key) },
  });
  return indentSchema.parse(requireData(result));
}
