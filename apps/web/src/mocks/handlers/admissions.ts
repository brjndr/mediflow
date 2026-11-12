import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset } from '../db';
import { authorize, error } from '../respond';
import { admissionFlowHandlers, announceBedsWith, mockBedPatient } from './admissions-flow';
import { mockPatient } from './patients';
import { housekeepMockBed, mockBoardBeds, onMockBedsChanged, setMockBedStatus } from './wards';

type BoardBed = components['schemas']['BoardBed'];
type BoardBedPage = components['schemas']['BoardBedPage'];
type BoardBedStatus = components['schemas']['BoardBedStatus'];

const FEATURE_FLAG = 'admissions';
const READ = 'admission:read';
const HOUSEKEEPING = 'bed:update';
const STATUSES: BoardBedStatus[] = ['available', 'occupied', 'cleaning', 'blocked'];

/** Who is in the seeded occupied beds. Ids only: names are looked up when the board is read. */
const OCCUPANTS: Record<string, string> = {
  'ward_h_gw-a_b1': 'pth_00001',
  'ward_h_gw-a_b2': 'pth_00002',
  ward_h_icu_b1: 'pth_00003',
};
const FALLBACK_PATIENT = 'pth_00004';

const streams = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();
const KEEP_ALIVE_MS = 20_000;
const keepAlive = new Map<
  ReadableStreamDefaultController<Uint8Array>,
  ReturnType<typeof setInterval>
>();

function stopKeepAlive(controller: ReadableStreamDefaultController<Uint8Array>) {
  clearInterval(keepAlive.get(controller));
  keepAlive.delete(controller);
}

function closeStreams(tenantId?: string) {
  for (const [id, open] of streams) {
    if (tenantId !== undefined && id !== tenantId) continue;
    for (const controller of open) {
      stopKeepAlive(controller);
      try {
        controller.close();
      } catch {
        // Already closed by the reader.
      }
    }
    open.clear();
  }
}

onMockReset(() => closeStreams());

/** Tells the hospital's open streams which ward changed: never who is in a bed. */
function publish(tenantId: string, wardId: string) {
  const message = encoder.encode(`event: beds\ndata: ${JSON.stringify({ wardId })}\n\n`);
  for (const controller of streams.get(tenantId) ?? []) {
    try {
      controller.enqueue(message);
    } catch {
      streams.get(tenantId)?.delete(controller);
    }
  }
}
onMockBedsChanged(publish);
announceBedsWith(publish);

/** For tests: how many event streams of a hospital were opened since the last reset. */
export const mockBedStreams = (tenantId: string) => streams.get(tenantId)?.size ?? 0;

/** For tests: the server closes a hospital's streams, as a restart does. */
export const closeMockBedStreams = (tenantId: string) => closeStreams(tenantId);

/** For tests: another desk changes a bed behind the open board, and the streams hear of it. */
export function changeMockBed(
  tenantId: string,
  bedId: string,
  wardId: string,
  status: BoardBedStatus,
): void {
  setMockBedStatus(bedId, status);
  publish(tenantId, wardId);
}

function view(tenantId: string, bed: ReturnType<typeof mockBoardBeds>[number]): BoardBed {
  const patient =
    bed.status === 'occupied'
      ? mockPatient(tenantId, mockBedPatient(bed.id) ?? OCCUPANTS[bed.id] ?? FALLBACK_PATIENT)
      : undefined;
  return {
    ...bed,
    ...(patient
      ? {
          occupant: {
            admissionId: `adm_${bed.id}`,
            patientId: patient.id,
            patientName: patient.name,
            patientMrn: patient.mrn,
            assignedAt: '2026-11-07T06:30:00.000Z',
          },
        }
      : {}),
  };
}

export const admissionsHandlers = [
  ...admissionFlowHandlers,
  http.get('*/api/beds/counts', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const wardId = new URL(request.url).searchParams.get('wardId');
    const beds = mockBoardBeds(access.tenantId).filter((bed) => !wardId || bed.wardId === wardId);
    return HttpResponse.json({
      counts: STATUSES.map((status) => ({
        status,
        count: beds.filter((bed) => bed.status === status).length,
      })),
    });
  }),

  http.get('*/api/beds/board', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const wardId = query.get('wardId');
    const status = query.get('status');
    if (status !== null && !STATUSES.includes(status as BoardBedStatus)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const all = mockBoardBeds(access.tenantId).filter(
      (bed) => (!wardId || bed.wardId === wardId) && (!status || bed.status === status),
    );
    const start = cursor ? all.findIndex((bed) => bed.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    return HttpResponse.json<BoardBedPage>({
      items: all.slice(start, start + limit).map((bed) => view(access.tenantId, bed)),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: all.length }),
    });
  }),

  http.post('*/api/beds/:bedId/housekeeping', async ({ request, params }) => {
    const access = authorize(request, { permission: HOUSEKEEPING, featureFlag: 'wards' });
    if ('denied' in access) return access.denied;
    if (request.headers.get('idempotency-key') === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body: unknown = await request.json().catch(() => null);
    const { status, version } = (body ?? {}) as { status?: unknown; version?: unknown };
    if ((status !== 'cleaning' && status !== 'available') || typeof version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const bedId = String(params.bedId);
    const result = housekeepMockBed(access.tenantId, bedId, status, version);
    if (result === 'not_found') return error(404, 'bed_not_found', 'No such bed');
    if (result !== 'ok') return error(409, result, 'It has changed');
    const bed = mockBoardBeds(access.tenantId).find((candidate) => candidate.id === bedId);
    return bed
      ? HttpResponse.json<BoardBed>(view(access.tenantId, bed))
      : error(404, 'bed_not_found', 'No such bed');
  }),

  http.get('*/api/beds/events', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
    const forget = () => {
      if (!mine) return;
      stopKeepAlive(mine);
      streams.get(tenantId)?.delete(mine);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        mine = controller;
        if (!streams.has(tenantId)) streams.set(tenantId, new Set());
        streams.get(tenantId)?.add(controller);
        controller.enqueue(encoder.encode(': open\n\n'));
        keepAlive.set(
          controller,
          setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              forget();
            }
          }, KEEP_ALIVE_MS),
        );
      },
      cancel: forget,
    });
    request.signal.addEventListener('abort', forget, { once: true });
    return new HttpResponse(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    });
  }),
];
