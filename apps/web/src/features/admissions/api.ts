import { api, requireData } from '@/shared/api';
import {
  admissionPageSchema,
  admissionDetailSchema,
  admissionSchema,
  bedCountsSchema,
  boardPageSchema,
  wardOptionsSchema,
  type BlockReason,
  type MoveReason,
} from './schemas';
import type {
  Admission,
  AdmissionCreate,
  AdmissionPage,
  BedCounts,
  BoardBed,
  BoardBedPage,
  BoardBedStatus,
  BedStay,
  DischargeType,
  WardOption,
} from './types';

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

/**
 * How many beds a ward (or every ward) has in each status, in one request. Counts only, so
 * no patient comes with it.
 */
export async function fetchBedCounts(
  { wardId }: { wardId: string },
  signal?: AbortSignal,
): Promise<BedCounts> {
  const result = await api.GET('/beds/counts', {
    params: { query: { wardId: wardId || undefined } },
    signal,
  });
  return bedCountsSchema.parse(requireData(result));
}

/**
 * The wards to filter by: names and ids only. `more` says the hospital has wards beyond this
 * page, so the screen searches instead of listing. `q` is a ward's code or name (a ward is not
 * patient data, so it stays a GET).
 */
export async function fetchWardOptions(
  { q, limit }: { q: string; limit: number },
  signal?: AbortSignal,
): Promise<{ items: WardOption[]; more: boolean }> {
  const result = await api.GET('/wards', {
    params: { query: { limit, q: q || undefined } },
    signal,
  });
  const page = wardOptionsSchema.parse(requireData(result));
  return { items: page.items, more: Boolean(page.nextCursor) };
}

export type BedAction =
  | { kind: 'housekeeping'; bed: BoardBed; status: 'cleaning' | 'available' }
  | { kind: 'block'; bed: BoardBed; reason: BlockReason }
  | { kind: 'unblock'; bed: BoardBed }
  | { kind: 'reserve'; bed: BoardBed; patientId: string; expiresAt: string }
  | { kind: 'release'; bed: BoardBed };

/** Marks a bed cleaning or ready, blocks it or puts it back in use, holds it for a patient or lets the hold go. */
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
    case 'reserve':
      requireData(
        await api.POST('/beds/{bedId}/reservations', {
          params: { path, header: { 'idempotency-key': key } },
          body: { patientId: action.patientId, expiresAt: action.expiresAt },
        }),
      );
      return;
    case 'release': {
      const reservationId = bed.reservation?.id;
      if (!reservationId) return;
      requireData(
        await api.POST('/bed-reservations/{reservationId}/cancel', {
          params: { path: { reservationId }, header: { 'idempotency-key': key } },
        }),
      );
      return;
    }
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

/** The admissions, newest first. Names the patients, so the server audits every row. */
export async function fetchAdmissions(
  {
    status,
    wardId,
    cursor,
    limit,
  }: { status: 'admitted' | 'discharged' | ''; wardId?: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<AdmissionPage> {
  const result = await api.GET('/admissions', {
    params: { query: { status: status || undefined, wardId: wardId || undefined, cursor, limit } },
    signal,
  });
  return admissionPageSchema.parse(requireData(result));
}

/** Admits a patient with the bed chosen, which opens the stay's inpatient encounter. */
export async function admitPatient(body: AdmissionCreate, key: string): Promise<Admission> {
  const result = await api.POST('/admissions', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return admissionSchema.parse(requireData(result));
}

/** Gives an admitted patient their first bed, or moves them to another. */
export async function changeAdmissionBed(
  admission: Admission,
  bedId: string,
  key: string,
  why: { reason?: MoveReason; note?: string } = {},
): Promise<Admission> {
  const params = { path: { admissionId: admission.id }, header: { 'idempotency-key': key } };
  const body = {
    bedId,
    version: admission.version,
    ...(why.reason ? { reason: why.reason } : {}),
    ...(why.reason && why.note ? { note: why.note } : {}),
  };
  const result = admission.bed
    ? await api.POST('/admissions/{admissionId}/transfer', { params, body })
    : await api.POST('/admissions/{admissionId}/assign-bed', { params, body });
  return admissionSchema.parse(requireData(result));
}

/** Discharges an admitted patient: closes the stay's encounter and frees the bed for cleaning. */
export async function dischargeAdmission(
  admission: Admission,
  dischargeType: DischargeType,
  key: string,
): Promise<Admission> {
  const result = await api.POST('/admissions/{admissionId}/discharge', {
    params: { path: { admissionId: admission.id }, header: { 'idempotency-key': key } },
    body: { dischargeType, version: admission.version },
  });
  return admissionDetailSchema.parse(requireData(result)).admission;
}

/** Every bed the patient has been in, oldest first. Audited by the server as a read. */
export async function fetchBedHistory(
  admissionId: string,
  signal?: AbortSignal,
): Promise<BedStay[]> {
  const result = await api.GET('/admissions/{admissionId}', {
    params: { path: { admissionId } },
    signal,
  });
  return admissionDetailSchema.parse(requireData(result)).stays;
}
