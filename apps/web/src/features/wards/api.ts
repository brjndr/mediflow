import { api, requireData } from '@/shared/api';
import {
  bedCategoryPageSchema,
  bedCategorySchema,
  wardDetailSchema,
  wardPageSchema,
} from './schemas';
import type {
  BedCategory,
  BedCategoryCreate,
  BedCategoryPage,
  BedCategoryUpdate,
  BedUpdate,
  BlockReason,
  WardCreate,
  WardDetail,
  WardPage,
  WardUpdate,
} from './types';

export interface WardFilters {
  /** A code or a name of a ward. Not patient data, so it may be a query. */
  q: string;
  archived: boolean;
}

const idempotent = (key: string) => ({ header: { 'idempotency-key': key } });

export async function fetchWards(
  { cursor, limit, q, archived }: WardFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<WardPage> {
  const result = await api.GET('/wards', {
    params: { query: { cursor, limit, q: q || undefined, archived } },
    signal,
  });
  return wardPageSchema.parse(requireData(result));
}

export async function fetchWard(wardId: string, signal?: AbortSignal): Promise<WardDetail> {
  const result = await api.GET('/wards/{wardId}', { params: { path: { wardId } }, signal });
  return wardDetailSchema.parse(requireData(result));
}

export async function createWard(body: WardCreate, key: string): Promise<WardDetail> {
  const result = await api.POST('/wards', { body, params: idempotent(key) });
  return wardDetailSchema.parse(requireData(result));
}

export async function updateWard(wardId: string, body: WardUpdate): Promise<WardDetail> {
  const result = await api.PATCH('/wards/{wardId}', { params: { path: { wardId } }, body });
  return wardDetailSchema.parse(requireData(result));
}

export async function setWardArchived(wardId: string, archived: boolean): Promise<WardDetail> {
  const params = { path: { wardId } };
  const result = archived
    ? await api.POST('/wards/{wardId}/archive', { params })
    : await api.POST('/wards/{wardId}/restore', { params });
  return wardDetailSchema.parse(requireData(result));
}

/** One change to a room or a bed of a ward. Each answers with the ward as it then is. */
export type WardAction =
  | { type: 'addRoom'; name: string; key: string }
  | { type: 'renameRoom'; roomId: string; name: string; expectedVersion: number }
  | { type: 'archiveRoom' | 'restoreRoom'; roomId: string }
  | { type: 'addBed'; roomId: string; number: string; bedCategoryId: string; key: string }
  | { type: 'updateBed'; bedId: string; body: BedUpdate }
  | { type: 'blockBed'; bedId: string; reason: BlockReason; note?: string }
  | { type: 'unblockBed' | 'archiveBed' | 'restoreBed'; bedId: string };

async function send(wardId: string, action: WardAction) {
  switch (action.type) {
    case 'addRoom':
      return api.POST('/wards/{wardId}/rooms', {
        params: { path: { wardId }, ...idempotent(action.key) },
        body: { name: action.name },
      });
    case 'renameRoom':
      return api.PATCH('/wards/{wardId}/rooms/{roomId}', {
        params: { path: { wardId, roomId: action.roomId } },
        body: { name: action.name, expectedVersion: action.expectedVersion },
      });
    case 'archiveRoom':
      return api.POST('/wards/{wardId}/rooms/{roomId}/archive', {
        params: { path: { wardId, roomId: action.roomId } },
      });
    case 'restoreRoom':
      return api.POST('/wards/{wardId}/rooms/{roomId}/restore', {
        params: { path: { wardId, roomId: action.roomId } },
      });
    case 'addBed':
      return api.POST('/wards/{wardId}/rooms/{roomId}/beds', {
        params: { path: { wardId, roomId: action.roomId }, ...idempotent(action.key) },
        body: { number: action.number, bedCategoryId: action.bedCategoryId },
      });
    case 'updateBed':
      return api.PATCH('/wards/{wardId}/beds/{bedId}', {
        params: { path: { wardId, bedId: action.bedId } },
        body: action.body,
      });
    case 'blockBed':
      return api.POST('/wards/{wardId}/beds/{bedId}/block', {
        params: { path: { wardId, bedId: action.bedId } },
        body: { reason: action.reason, ...(action.note ? { note: action.note } : {}) },
      });
    case 'unblockBed':
      return api.POST('/wards/{wardId}/beds/{bedId}/unblock', {
        params: { path: { wardId, bedId: action.bedId } },
      });
    case 'archiveBed':
      return api.POST('/wards/{wardId}/beds/{bedId}/archive', {
        params: { path: { wardId, bedId: action.bedId } },
      });
    case 'restoreBed':
      return api.POST('/wards/{wardId}/beds/{bedId}/restore', {
        params: { path: { wardId, bedId: action.bedId } },
      });
  }
}

export async function runWardAction(wardId: string, action: WardAction): Promise<WardDetail> {
  return wardDetailSchema.parse(requireData(await send(wardId, action)));
}

export async function fetchBedCategories(
  archived: boolean,
  limit: number,
  signal?: AbortSignal,
): Promise<BedCategoryPage> {
  const result = await api.GET('/bed-categories', {
    params: { query: { archived, limit } },
    signal,
  });
  return bedCategoryPageSchema.parse(requireData(result));
}

export async function createBedCategory(
  body: BedCategoryCreate,
  key: string,
): Promise<BedCategory> {
  const result = await api.POST('/bed-categories', { body, params: idempotent(key) });
  return bedCategorySchema.parse(requireData(result));
}

export async function updateBedCategory(
  bedCategoryId: string,
  body: BedCategoryUpdate,
): Promise<BedCategory> {
  const result = await api.PATCH('/bed-categories/{bedCategoryId}', {
    params: { path: { bedCategoryId } },
    body,
  });
  return bedCategorySchema.parse(requireData(result));
}

export async function setBedCategoryArchived(
  bedCategoryId: string,
  archived: boolean,
): Promise<BedCategory> {
  const params = { path: { bedCategoryId } };
  const result = archived
    ? await api.POST('/bed-categories/{bedCategoryId}/archive', { params })
    : await api.POST('/bed-categories/{bedCategoryId}/restore', { params });
  return bedCategorySchema.parse(requireData(result));
}
