import { api, requireData } from '@/shared/api';
import { boardPageSchema, wardOptionsSchema, type BlockReason } from './schemas';
import type { BoardBed, BoardBedPage, BoardBedStatus, WardOption } from './types';

export interface BoardFilters {
  /** Empty: every ward. */
  wardId: string;
  /** Empty: every status. */
  status: BoardBedStatus | '';
}

/** The beds in use by ward name and bed number. Names the patients, so the server audits it. */
export async function fetchBoard(
  { wardId, status, cursor, limit }: BoardFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<BoardBedPage> {
  const result = await api.GET('/beds/board', {
    params: { query: { wardId: wardId || undefined, status: status || undefined, cursor, limit } },
    signal,
  });
  return boardPageSchema.parse(requireData(result));
}

/** The wards to filter by: names and ids only. A hospital has a few dozen at most. */
export async function fetchWardOptions(signal?: AbortSignal): Promise<WardOption[]> {
  const result = await api.GET('/wards', { params: { query: { limit: 100 } }, signal });
  return wardOptionsSchema.parse(requireData(result)).items;
}

export type BedAction =
  | { kind: 'housekeeping'; bed: BoardBed; status: 'cleaning' | 'available' }
  | { kind: 'block'; bed: BoardBed; reason: BlockReason }
  | { kind: 'unblock'; bed: BoardBed };

/** Marks a bed cleaning or ready, blocks it or puts it back in use. */
export async function changeBed(action: BedAction, key: string): Promise<void> {
  const { bed } = action;
  const path = { bedId: bed.id };
  const ward = { wardId: bed.wardId, bedId: bed.id };
  switch (action.kind) {
    case 'housekeeping':
      requireData(
        await api.POST('/beds/{bedId}/housekeeping', {
          params: { path, header: { 'idempotency-key': key } },
          body: { status: action.status, version: bed.version },
        }),
      );
      return;
    case 'block':
      requireData(
        await api.POST('/wards/{wardId}/beds/{bedId}/block', {
          params: { path: ward },
          body: { reason: action.reason },
        }),
      );
      return;
    case 'unblock':
      requireData(
        await api.POST('/wards/{wardId}/beds/{bedId}/unblock', { params: { path: ward } }),
      );
      return;
  }
}

/**
 * Opens the hospital's bed event stream through the API client (session cookie, tenant header,
 * error handling). Its events say which ward changed, never who is in a bed.
 */
export async function openBedEvents(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const result = await api.GET('/beds/events', { parseAs: 'stream', signal });
  if (!result.data) throw new TypeError('Expected an event stream');
  return result.data;
}
