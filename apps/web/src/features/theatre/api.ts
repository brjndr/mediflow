import { api, requireData } from '@/shared/api';
import {
  periopSchema,
  roomPageSchema,
  roomSchema,
  surgeryPageSchema,
  surgerySchema,
} from './schemas';
import type {
  AnaesthesiaInput,
  ChecklistStepCode,
  FitnessStatus,
  OtRoom,
  OtRoomPage,
  PeriopRecord,
  Surgery,
  SurgeryPage,
  SurgeryStatus,
} from './types';

export async function fetchRooms(
  { archived, cursor, limit }: { archived?: boolean; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<OtRoomPage> {
  const result = await api.GET('/theatre/rooms', {
    params: { query: { archived, cursor, limit } },
    signal,
  });
  return roomPageSchema.parse(requireData(result));
}

export async function createRoom(body: { name: string }, key: string): Promise<OtRoom> {
  const result = await api.POST('/theatre/rooms', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return roomSchema.parse(requireData(result));
}

/** Rename or archive a theatre; the version read is sent. */
export async function updateRoom(change: {
  room: OtRoom;
  name?: string;
  archived?: boolean;
}): Promise<OtRoom> {
  const { room, name, archived } = change;
  const result = await api.PATCH('/theatre/rooms/{roomId}', {
    params: { path: { roomId: room.id } },
    body: {
      version: room.version,
      ...(name !== undefined ? { name } : {}),
      ...(archived !== undefined ? { archived } : {}),
    },
  });
  return roomSchema.parse(requireData(result));
}

export async function fetchSurgeries(
  query: {
    from: string;
    to: string;
    roomId?: string;
    status?: SurgeryStatus;
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<SurgeryPage> {
  const result = await api.GET('/theatre/surgeries', { params: { query }, signal });
  return surgeryPageSchema.parse(requireData(result));
}

export interface BookSurgery {
  patientId: string;
  roomId: string;
  surgeonId: string;
  serviceId?: string;
  procedure: string;
  notes?: string;
  startsAt: string;
  endsAt: string;
}

export async function bookSurgery(body: BookSurgery, key: string): Promise<Surgery> {
  const result = await api.POST('/theatre/surgeries', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return surgerySchema.parse(requireData(result));
}

export interface RescheduleSurgery {
  surgery: Surgery;
  roomId: string;
  surgeonId: string;
  startsAt: string;
  endsAt: string;
}

export async function rescheduleSurgery(
  { surgery, ...change }: RescheduleSurgery,
  key: string,
): Promise<Surgery> {
  const result = await api.POST('/theatre/surgeries/{surgeryId}/reschedule', {
    params: { path: { surgeryId: surgery.id }, header: { 'idempotency-key': key } },
    body: { ...change, version: surgery.version },
  });
  return surgerySchema.parse(requireData(result));
}

export interface MoveSurgery {
  surgery: Surgery;
  to: 'start' | 'complete' | 'cancel';
  /** Required to cancel. */
  reason?: string;
}

export async function moveSurgery(move: MoveSurgery, key: string): Promise<Surgery> {
  const params = { path: { surgeryId: move.surgery.id }, header: { 'idempotency-key': key } };
  const version = move.surgery.version;
  const result =
    move.to === 'cancel'
      ? await api.POST('/theatre/surgeries/{surgeryId}/cancel', {
          params,
          body: { reason: move.reason ?? '', version },
        })
      : move.to === 'start'
        ? await api.POST('/theatre/surgeries/{surgeryId}/start', { params, body: { version } })
        : await api.POST('/theatre/surgeries/{surgeryId}/complete', { params, body: { version } });
  return surgerySchema.parse(requireData(result));
}

export async function fetchPeriop(surgeryId: string, signal?: AbortSignal): Promise<PeriopRecord> {
  const result = await api.GET('/theatre/surgeries/{surgeryId}/periop', {
    params: { path: { surgeryId } },
    signal,
  });
  return periopSchema.parse(requireData(result));
}

export async function recordFitness(
  surgeryId: string,
  body: { status: FitnessStatus; notes?: string },
): Promise<PeriopRecord> {
  const result = await api.PUT('/theatre/surgeries/{surgeryId}/fitness', {
    params: { path: { surgeryId } },
    body,
  });
  return periopSchema.parse(requireData(result));
}

export async function completeStep(
  change: { surgeryId: string; step: ChecklistStepCode; note?: string },
  key: string,
): Promise<PeriopRecord> {
  const result = await api.POST('/theatre/surgeries/{surgeryId}/checklist/{step}', {
    params: {
      path: { surgeryId: change.surgeryId, step: change.step },
      header: { 'idempotency-key': key },
    },
    body: change.note ? { note: change.note } : {},
  });
  return periopSchema.parse(requireData(result));
}

export async function saveAnaesthesia(
  surgeryId: string,
  body: AnaesthesiaInput,
): Promise<PeriopRecord> {
  const result = await api.PUT('/theatre/surgeries/{surgeryId}/anaesthesia', {
    params: { path: { surgeryId } },
    body,
  });
  return periopSchema.parse(requireData(result));
}

export async function signAnaesthesia(surgeryId: string, key: string): Promise<PeriopRecord> {
  const result = await api.POST('/theatre/surgeries/{surgeryId}/anaesthesia/sign', {
    params: { path: { surgeryId }, header: { 'idempotency-key': key } },
  });
  return periopSchema.parse(requireData(result));
}
