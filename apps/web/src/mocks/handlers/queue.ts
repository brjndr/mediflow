import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { todayIn } from '@/shared/utils/timezone';
import { currentSession, mockTenantTimezone, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDepartment } from './departments';
import { mockDoctor } from './doctors';
import { mockPatient } from './patients';

type QueueToken = components['schemas']['QueueToken'];
type QueueTokenPage = components['schemas']['QueueTokenPage'];
type QueueTokenStatus = components['schemas']['QueueTokenStatus'];
type QueuePriority = components['schemas']['QueuePriority'];

const FEATURE_FLAG = 'queue';
const READ = 'queue:read';
const CREATE = 'queue:create';
const CALL = 'queue:call';
const STATUSES: QueueTokenStatus[] = ['waiting', 'called', 'served', 'skipped'];
const PRIORITIES: QueuePriority[] = [
  'senior_citizen',
  'pregnancy',
  'disability',
  'child',
  'clinical_urgency',
];

/** What the mock keeps: ids, never names, which are looked up when it answers, as the API joins them. */
export interface StoredToken {
  id: string;
  tenantId: string;
  number: number;
  day: string;
  departmentId: string;
  doctorId?: string;
  patientId: string;
  status: QueueTokenStatus;
  priority?: QueuePriority;
  issuedAt: string;
  calledAt?: string;
  callCount: number;
  version: number;
}

const minutesAgo = (now: Date, minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

/**
 * Today's queue at each hospital: at the hospital, tokens in the first three departments, some
 * for a doctor and some for any doctor of the department, one being served and one skipped; at
 * the clinic, a few in its first department. The doctors are those whose profiles are in those
 * departments (`doc_h_01` in `dep_h_01`, and so on).
 */
function seed(now = new Date()): StoredToken[] {
  const tokens: StoredToken[] = [];
  const add = (
    tenantId: string,
    departmentId: string,
    patientId: string,
    extra: Partial<StoredToken> = {},
  ) => {
    const day = todayIn(mockTenantTimezone(tenantId), now);
    const number =
      tokens.filter((t) => t.tenantId === tenantId && t.departmentId === departmentId).length + 1;
    tokens.push({
      id: `qt_${tenantId}_${departmentId}_${number}`,
      tenantId,
      number,
      day,
      departmentId,
      patientId,
      status: 'waiting',
      issuedAt: minutesAgo(now, 60 - tokens.length * 3),
      callCount: 0,
      version: 1,
      ...extra,
    });
  };
  const hospital = TENANT_IDS.hospital;
  add(hospital, 'dep_h_01', 'pth_00101', {
    doctorId: 'doc_h_01',
    status: 'called',
    calledAt: minutesAgo(now, 5),
    callCount: 1,
  });
  add(hospital, 'dep_h_01', 'pth_00102', { doctorId: 'doc_h_01' });
  add(hospital, 'dep_h_01', 'pth_00103');
  add(hospital, 'dep_h_01', 'pth_00104', { priority: 'senior_citizen' });
  add(hospital, 'dep_h_01', 'pth_00105', {
    doctorId: 'doc_h_01',
    status: 'skipped',
    calledAt: minutesAgo(now, 20),
    callCount: 2,
  });
  add(hospital, 'dep_h_02', 'pth_00201', { doctorId: 'doc_h_02' });
  add(hospital, 'dep_h_02', 'pth_00202');
  add(hospital, 'dep_h_03', 'pth_00301', { doctorId: 'doc_h_03', priority: 'pregnancy' });
  const clinic = TENANT_IDS.clinic;
  add(clinic, 'dep_c_01', 'ptc_00001', { doctorId: 'doc_c_01' });
  add(clinic, 'dep_c_01', 'ptc_00002');
  return tokens;
}

let tokens = seed();
/** Requests already answered, by tenant, user and idempotency key, as the API keeps them. */
let answered = new Map<string, { body: string; status: number; token: QueueToken }>();
/** The open event streams of each hospital. */
const streams = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();
/** The keep-alive comment of each open stream, as the API sends one every 20 seconds. */
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

onMockReset(() => {
  tokens = seed();
  answered = new Map();
  closeStreams();
});

/** Tells every open stream of the hospital that a department's queue changed: which, never who. */
function publish(tenantId: string, departmentId: string) {
  const message = encoder.encode(`event: queue\ndata: ${JSON.stringify({ departmentId })}\n\n`);
  for (const controller of streams.get(tenantId) ?? []) {
    try {
      controller.enqueue(message);
    } catch {
      streams.get(tenantId)?.delete(controller);
    }
  }
}

/**
 * For tests: how many event streams of a hospital were opened since the last reset. MSW does
 * not pass on a stream the browser closed, so this counts openings, not streams still open.
 */
export const mockQueueStreams = (tenantId: string) => streams.get(tenantId)?.size ?? 0;

/** For tests: the server closes a hospital's streams, as a restart or a proxy timeout does. */
export const dropMockQueueStreams = (tenantId: string) => closeStreams(tenantId);

/** For tests: another desk changes the queue behind the open screen, and the streams hear of it. */
export function addMockQueueToken(
  token: Omit<StoredToken, 'number' | 'day'> & Partial<StoredToken>,
) {
  const day = todayIn(mockTenantTimezone(token.tenantId));
  const number =
    Math.max(
      0,
      ...tokens
        .filter(
          (t) =>
            t.tenantId === token.tenantId && t.departmentId === token.departmentId && t.day === day,
        )
        .map((t) => t.number),
    ) + 1;
  tokens.push({ number, day, ...token });
  publish(token.tenantId, token.departmentId);
}

/** For tests: a token as the mock holds it. */
export const mockQueueToken = (id: string) => tokens.find((token) => token.id === id);

function viewOf(stored: StoredToken): QueueToken | null {
  const patient = mockPatient(stored.tenantId, stored.patientId);
  const department = mockDepartment(stored.tenantId, stored.departmentId);
  if (!patient || !department) return null;
  const doctor = stored.doctorId ? mockDoctor(stored.tenantId, stored.doctorId) : undefined;
  return {
    id: stored.id,
    tenantId: stored.tenantId,
    number: stored.number,
    day: stored.day,
    departmentId: department.id,
    departmentName: department.name,
    ...(doctor ? { doctorId: doctor.id, doctorName: doctor.name } : {}),
    patientId: patient.id,
    patientName: patient.name,
    patientMrn: patient.mrn,
    status: stored.status,
    ...(stored.priority ? { priority: stored.priority } : {}),
    issuedAt: stored.issuedAt,
    ...(stored.calledAt ? { calledAt: stored.calledAt } : {}),
    callCount: stored.callCount,
    version: stored.version,
  };
}

/** Call order: a priority first, then the time issued. The called ones by when they were called. */
function inCallOrder(a: StoredToken, b: StoredToken): number {
  if (a.status === 'called' && b.status === 'called') {
    return (a.calledAt ?? '').localeCompare(b.calledAt ?? '');
  }
  return (
    Number(b.priority !== undefined) - Number(a.priority !== undefined) ||
    a.issuedAt.localeCompare(b.issuedAt) ||
    a.number - b.number
  );
}

/** A doctor's queue: theirs, and the tokens of their department issued for no doctor. */
function inDoctorsQueue(token: StoredToken, doctorId: string, departmentId: string): boolean {
  return (
    token.doctorId === doctorId ||
    (token.doctorId === undefined && token.departmentId === departmentId)
  );
}

const today = (tenantId: string) => todayIn(mockTenantTimezone(tenantId));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Runs a change once per idempotency key, as the API does: a repeat gives the first answer, the
 * same key with another body is refused. Nothing is awaited between the checks and the change,
 * so two at once are decided one after the other, as the database's row locks decide them.
 */
async function once(
  request: Request,
  permission: string,
  change: (tenantId: string, body: unknown) => { status: number; token: StoredToken } | Response,
) {
  const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
  if ('denied' in access) return access.denied;
  const key = request.headers.get('Idempotency-Key');
  if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
  const body: unknown = await request.json().catch(() => null);
  const keyOf = `${access.tenantId}:${currentSession()?.user.id ?? ''}:${new URL(request.url).pathname}:${key}`;
  const replay = answered.get(keyOf);
  if (replay) {
    if (replay.body !== JSON.stringify(body)) {
      return error(422, 'idempotency_key_reuse', 'This key was used for a different request');
    }
    return HttpResponse.json<QueueToken>(replay.token, { status: replay.status });
  }
  const result = change(access.tenantId, body);
  if (result instanceof Response) return result;
  const view = viewOf(result.token) as QueueToken;
  answered.set(keyOf, { body: JSON.stringify(body), status: result.status, token: view });
  publish(access.tenantId, result.token.departmentId);
  return HttpResponse.json<QueueToken>(view, { status: result.status });
}

/** A change of one token from the version it was looked at in, when its status allows it. */
function tokenChange(
  path: string,
  allowed: QueueTokenStatus[],
  apply: (token: StoredToken, body: Record<string, unknown>) => Response | void,
) {
  return http.post(`*/api/queue/tokens/:tokenId/${path}`, ({ request, params }) =>
    once(request, CALL, (tenantId, body) => {
      if (!isObject(body) || !Number.isInteger(body.version)) {
        return error(400, 'validation_failed', 'Some details are not valid');
      }
      const token = tokens.find((t) => t.id === params.tokenId && t.tenantId === tenantId);
      if (!token || token.day !== today(tenantId))
        return error(404, 'token_not_found', 'No such token');
      if (body.version !== token.version) return error(409, 'conflict', 'It has changed');
      if (!allowed.includes(token.status)) {
        return error(409, 'invalid_transition', `Not from ${token.status}`);
      }
      const refused = apply(token, body);
      if (refused) return refused;
      token.version += 1;
      return { status: 200, token };
    }),
  );
}

export const queueHandlers = [
  http.get('*/api/queue/tokens', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const status = params.get('status') as QueueTokenStatus | null;
    if (!status || !STATUSES.includes(status)) return error(400, 'validation_failed', 'Bad status');
    const limit = Number(params.get('limit') ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return error(400, 'validation_failed', 'Bad limit');
    }
    const departmentId = params.get('departmentId');
    const doctorId = params.get('doctorId');
    const cursor = params.get('cursor');
    const { tenantId } = access;
    const doctor = doctorId ? mockDoctor(tenantId, doctorId) : undefined;
    if (doctorId && !doctor)
      return HttpResponse.json<QueueTokenPage>({ items: [], nextCursor: null, total: 0 });
    // Today at the hospital, in its own timezone: the session's tenant, never the request's.
    const visible = tokens
      .filter((token) => token.tenantId === tenantId && token.day === today(tenantId))
      .filter((token) => token.status === status)
      .filter((token) => !departmentId || token.departmentId === departmentId)
      .filter((token) => !doctor || inDoctorsQueue(token, doctor.id, doctor.departmentId))
      .sort(inCallOrder);
    const first = cursor ? visible.findIndex((token) => token.id === cursor) : 0;
    if (first < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[first + limit];
    return HttpResponse.json<QueueTokenPage>({
      items: visible
        .slice(first, first + limit)
        .map(viewOf)
        .filter((token): token is QueueToken => token !== null),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: visible.length }),
    });
  }),

  http.get('*/api/queue/events', ({ request }) => {
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
        // A comment first, as the API sends, so the response starts at once.
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

  http.post('*/api/queue/tokens', ({ request }) =>
    once(request, CREATE, (tenantId, body) => {
      // Issuing names the patient back: it needs reading patients too, and says no more than
      // "unknown" to a role that may not.
      if ('denied' in authorize(request, { permission: 'patient:read' })) {
        return error(422, 'unknown_patient', 'No such patient');
      }
      if (
        !isObject(body) ||
        typeof body.patientId !== 'string' ||
        typeof body.departmentId !== 'string' ||
        (body.doctorId !== undefined && typeof body.doctorId !== 'string') ||
        (body.priority !== undefined && !PRIORITIES.includes(body.priority as QueuePriority))
      ) {
        return error(400, 'validation_failed', 'Some details are not valid');
      }
      if (!mockPatient(tenantId, body.patientId)) {
        return error(422, 'unknown_patient', 'No such patient');
      }
      const department = mockDepartment(tenantId, body.departmentId);
      if (!department || department.archived) {
        return error(422, 'unknown_department', 'No such department');
      }
      if (body.doctorId !== undefined) {
        const doctor = mockDoctor(tenantId, body.doctorId);
        if (!doctor?.active || doctor.departmentId !== department.id) {
          return error(422, 'doctor_not_in_department', 'Not a doctor of this department');
        }
      }
      const day = today(tenantId);
      const sameDay = tokens.filter(
        (t) => t.tenantId === tenantId && t.departmentId === department.id && t.day === day,
      );
      if (sameDay.some((t) => t.patientId === body.patientId && t.status !== 'served')) {
        return error(409, 'already_queued', 'The patient is already in this queue');
      }
      const number = Math.max(0, ...sameDay.map((t) => t.number)) + 1;
      const token: StoredToken = {
        id: `qt_${tenantId}_${department.id}_new_${number}`,
        tenantId,
        number,
        day,
        departmentId: department.id,
        ...(typeof body.doctorId === 'string' ? { doctorId: body.doctorId } : {}),
        patientId: body.patientId,
        status: 'waiting',
        ...(body.priority ? { priority: body.priority as QueuePriority } : {}),
        issuedAt: new Date().toISOString(),
        callCount: 0,
        version: 1,
      };
      tokens.push(token);
      return { status: 201, token };
    }),
  ),

  http.post('*/api/queue/call-next', ({ request }) =>
    once(request, CALL, (tenantId, body) => {
      if (!isObject(body) || typeof body.doctorId !== 'string') {
        return error(400, 'validation_failed', 'Some details are not valid');
      }
      const doctor = mockDoctor(tenantId, body.doctorId);
      if (!doctor?.active) return error(422, 'unknown_doctor', 'No such doctor');
      const day = today(tenantId);
      const mineToday = tokens.filter(
        (t) =>
          t.tenantId === tenantId &&
          t.day === day &&
          inDoctorsQueue(t, doctor.id, doctor.departmentId),
      );
      const next = mineToday.filter((t) => t.status === 'waiting').sort(inCallOrder)[0];
      if (!next) return error(409, 'queue_empty', 'Nobody is waiting');
      // The patient the doctor was serving has been seen.
      for (const serving of mineToday) {
        if (serving.status === 'called' && serving.doctorId === doctor.id) {
          serving.status = 'served';
          serving.version += 1;
        }
      }
      next.status = 'called';
      next.doctorId = doctor.id;
      next.calledAt = new Date().toISOString();
      next.callCount += 1;
      next.version += 1;
      return { status: 200, token: next };
    }),
  ),

  tokenChange('call-again', ['called'], (token) => {
    token.calledAt = new Date().toISOString();
    token.callCount += 1;
  }),
  tokenChange('skip', ['called'], (token) => {
    token.status = 'skipped';
  }),
  tokenChange('recall', ['skipped'], (token) => {
    token.status = 'waiting';
  }),
  tokenChange('priority', ['waiting', 'skipped'], (token, body) => {
    if (body.priority === null) {
      delete token.priority;
      return;
    }
    if (!PRIORITIES.includes(body.priority as QueuePriority)) {
      return error(400, 'validation_failed', 'Unknown priority');
    }
    token.priority = body.priority as QueuePriority;
  }),
];
