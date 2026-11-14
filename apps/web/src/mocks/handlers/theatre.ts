import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Room = components['schemas']['OtRoom'];
type Surgery = components['schemas']['Surgery'];
type Status = Surgery['status'];
type Periop = components['schemas']['PeriopRecord'];
type StepCode = components['schemas']['ChecklistStepCode'];

const FEATURE_FLAG = 'theatre';

/** The day the seeded surgery is on, far enough ahead that it never is "in the past". */
export const SEEDED_DAY = '2030-01-15';

const seedRooms = (): Room[] => [
  { id: 'otr_1', tenantId: TENANT_IDS.hospital, name: 'Theatre 1', archived: false, version: 1 },
  { id: 'otr_2', tenantId: TENANT_IDS.hospital, name: 'Theatre 2', archived: false, version: 1 },
];
// 09:30 to 11:00 on the hospital's clock (Asia/Kolkata, UTC+5:30).
const seedSurgeries = (): Surgery[] => [
  {
    id: 'sur_1',
    tenantId: TENANT_IDS.hospital,
    roomId: 'otr_1',
    surgeonId: 'doc_h_01',
    patientId: 'pth_00001',
    procedure: 'Appendicectomy',
    startsAt: `${SEEDED_DAY}T04:00:00.000Z`,
    endsAt: `${SEEDED_DAY}T05:30:00.000Z`,
    status: 'scheduled',
    version: 1,
  },
];

let rooms = seedRooms();
let surgeries = seedSurgeries();
let created = 0;
// The pre-operative record of each surgery, by tenant and surgery id.
let periops = new Map<string, Periop>();
const replies = new Map<string, string>();
onMockReset(() => {
  rooms = seedRooms();
  surgeries = seedSurgeries();
  created = 0;
  periops = new Map();
  replies.clear();
});

const MOVES: Record<Status, Status[]> = {
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};
const live = (s: Surgery) => s.status === 'scheduled' || s.status === 'in_progress';
const overlaps = (a: Surgery, b: { startsAt: string; endsAt: string }) =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** The refusal the database constraints give: theatre, surgeon or patient already booked. */
function clash(
  tenantId: string,
  candidate: Pick<Surgery, 'roomId' | 'surgeonId' | 'startsAt' | 'endsAt'> & {
    patientId?: string;
  },
  ignore?: string,
) {
  const others = surgeries.filter(
    (s) => s.tenantId === tenantId && s.id !== ignore && live(s) && overlaps(s, candidate),
  );
  if (others.some((s) => s.roomId === candidate.roomId)) {
    return error(409, 'room_taken', 'The theatre is booked at that time');
  }
  if (others.some((s) => s.surgeonId === candidate.surgeonId)) {
    return error(409, 'surgeon_busy', 'The surgeon is booked at that time');
  }
  if (candidate.patientId && others.some((s) => s.patientId === candidate.patientId)) {
    return error(409, 'patient_busy', 'The patient is booked at that time');
  }
  return undefined;
}

function page<T extends { id: string }>(all: T[], query: URLSearchParams) {
  const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((row) => row.id === cursor) : 0;
  if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
  const next = all[start + limit];
  return HttpResponse.json({
    items: all.slice(start, start + limit),
    nextCursor: next ? next.id : null,
    ...(cursor ? {} : { total: all.length }),
  });
}

const withKey = (request: Request) => request.headers.get('Idempotency-Key');
const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

function timesOk(startsAt: unknown, endsAt: unknown): boolean {
  return (
    isString(startsAt) &&
    isString(endsAt) &&
    !Number.isNaN(Date.parse(startsAt)) &&
    !Number.isNaN(Date.parse(endsAt)) &&
    Date.parse(endsAt) > Date.parse(startsAt)
  );
}

/** The steps in the order of their phases, as the real API holds them. */
const PHASES: StepCode[][] = [
  ['consent_confirmed', 'site_marked', 'fasting_confirmed'],
  ['identity_confirmed', 'anaesthesia_check_done', 'allergies_checked'],
  ['team_introduced', 'procedure_confirmed', 'antibiotic_given'],
  ['counts_correct', 'specimens_labelled', 'concerns_handed_over'],
];

function periopOf(tenantId: string, surgeryId: string): Periop {
  const key = `${tenantId}:${surgeryId}`;
  let record = periops.get(key);
  if (!record) {
    record = { surgeryId, checklist: [], fitness: null, anaesthesia: null };
    periops.set(key, record);
  }
  return record;
}

const signer = () => {
  const user = currentSession()?.user;
  return { id: user?.id ?? 'usr_unknown', name: user?.name ?? 'Unknown' };
};

/** Reads and changes of one surgery's record, with the refusals the real API gives. */
function periopRoute(
  request: Request,
  surgeryId: unknown,
  permission: string,
  change?: (record: Periop, surgery: Surgery) => Response | undefined,
): Response {
  const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
  if ('denied' in access) return access.denied;
  const surgery = surgeries.find((s) => s.id === surgeryId && s.tenantId === access.tenantId);
  if (!surgery) return error(404, 'surgery_not_found', 'No such surgery');
  const record = periopOf(access.tenantId, surgery.id);
  if (change) {
    if (surgery.status !== 'scheduled' && surgery.status !== 'in_progress') {
      return error(409, 'invalid_state', 'The surgery is finished or cancelled');
    }
    const refused = change(record, surgery);
    if (refused) return refused;
  }
  return HttpResponse.json(record);
}

export const theatreHandlers = [
  http.get('*/api/theatre/surgeries/:surgeryId/periop', ({ request, params }) =>
    periopRoute(request, params.surgeryId, 'theatre:read'),
  ),

  http.put('*/api/theatre/surgeries/:surgeryId/fitness', async ({ request, params }) => {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as {
      status?: unknown;
      notes?: unknown;
    } | null;
    if (!['fit', 'conditional', 'unfit'].includes(String(body?.status))) return invalid();
    return periopRoute(request, params.surgeryId, 'surgery:perform', (record) => {
      const who = signer();
      record.fitness = {
        status: body?.status as 'fit',
        ...(isString(body?.notes) ? { notes: body.notes } : {}),
        assessedAt: new Date().toISOString(),
        assessedBy: who.id,
        assessedByName: who.name,
      };
      return undefined;
    });
  }),

  http.post('*/api/theatre/surgeries/:surgeryId/checklist/:step', async ({ request, params }) => {
    const step = params.step as StepCode;
    const phase = PHASES.findIndex((steps) => steps.includes(step));
    if (phase < 0) return invalid();
    if (!withKey(request)) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { note?: unknown } | null;
    return periopRoute(request, params.surgeryId, 'surgery:perform', (record) => {
      if (record.checklist.some((entry) => entry.step === step)) return undefined;
      const done = new Set(record.checklist.map((entry) => entry.step));
      if (!PHASES.slice(0, phase).every((steps) => steps.every((s) => done.has(s)))) {
        return error(409, 'phase_incomplete', 'Earlier steps are not done');
      }
      const who = signer();
      record.checklist.push({
        step,
        completedAt: new Date().toISOString(),
        completedBy: who.id,
        completedByName: who.name,
        ...(isString(body?.note) ? { note: body.note } : {}),
      });
      return undefined;
    });
  }),

  http.put('*/api/theatre/surgeries/:surgeryId/anaesthesia', async ({ request, params }) => {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as {
      technique?: unknown;
      asaClass?: unknown;
      drugs?: unknown;
      notes?: unknown;
    } | null;
    if (
      !['general', 'spinal', 'epidural', 'regional', 'local', 'sedation'].includes(
        String(body?.technique),
      ) ||
      typeof body?.asaClass !== 'number' ||
      body.asaClass < 1 ||
      body.asaClass > 6
    ) {
      return invalid();
    }
    return periopRoute(request, params.surgeryId, 'surgery:perform', (record) => {
      if (record.anaesthesia?.signedAt) {
        return error(409, 'already_signed', 'The record is signed');
      }
      record.anaesthesia = {
        technique: body.technique as 'general',
        asaClass: body.asaClass as number,
        ...(isString(body.drugs) ? { drugs: body.drugs } : {}),
        ...(isString(body.notes) ? { notes: body.notes } : {}),
        savedAt: new Date().toISOString(),
      };
      return undefined;
    });
  }),

  http.post('*/api/theatre/surgeries/:surgeryId/anaesthesia/sign', ({ request, params }) => {
    if (!withKey(request)) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    return periopRoute(request, params.surgeryId, 'surgery:perform', (record) => {
      if (!record.anaesthesia) return error(404, 'anaesthesia_not_found', 'No record to sign');
      if (record.anaesthesia.signedAt) return undefined;
      const who = signer();
      Object.assign(record.anaesthesia, {
        signedAt: new Date().toISOString(),
        signedBy: who.id,
        signedByName: who.name,
      });
      return undefined;
    });
  }),

  http.get('*/api/theatre/rooms', ({ request }) => {
    const access = authorize(request, { permission: 'theatre:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const archived = query.get('archived');
    return page(
      rooms.filter(
        (r) =>
          r.tenantId === access.tenantId && (archived === null || String(r.archived) === archived),
      ),
      query,
    );
  }),

  http.post('*/api/theatre/rooms', async ({ request }) => {
    const access = authorize(request, { permission: 'theatre:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = withKey(request);
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    if (!isString(body?.name)) return invalid();
    const replyKey = `${access.tenantId}:${key}`;
    const known = replies.get(replyKey);
    const existing = known ? rooms.find((r) => r.id === known) : undefined;
    if (existing) return HttpResponse.json(existing, { status: 201 });
    if (rooms.some((r) => r.tenantId === access.tenantId && r.name === body.name)) {
      return error(409, 'name_taken', 'That name exists');
    }
    created += 1;
    const made: Room = {
      id: `otr_new_${created}`,
      tenantId: access.tenantId,
      name: body.name,
      archived: false,
      version: 1,
    };
    rooms.push(made);
    replies.set(replyKey, made.id);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.patch('*/api/theatre/rooms/:roomId', async ({ request, params }) => {
    const access = authorize(request, { permission: 'theatre:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      archived?: unknown;
      version?: unknown;
    } | null;
    if (typeof body?.version !== 'number') return invalid();
    const row = rooms.find((r) => r.id === params.roomId && r.tenantId === access.tenantId);
    if (!row) return error(404, 'room_not_found', 'No such theatre');
    if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
    if (isString(body.name)) row.name = body.name;
    if (typeof body.archived === 'boolean') row.archived = body.archived;
    row.version += 1;
    return HttpResponse.json(row);
  }),

  http.get('*/api/theatre/surgeries', ({ request }) => {
    const access = authorize(request, { permission: 'theatre:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const from = query.get('from');
    const to = query.get('to');
    if (!from || !to) return invalid();
    const roomId = query.get('roomId');
    const status = query.get('status');
    return page(
      surgeries
        .filter(
          (s) =>
            s.tenantId === access.tenantId &&
            s.startsAt < to &&
            s.endsAt > from &&
            (!roomId || s.roomId === roomId) &&
            (status ? s.status === status : s.status !== 'cancelled'),
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      query,
    );
  }),

  http.post('*/api/theatre/surgeries', async ({ request }) => {
    const access = authorize(request, {
      permission: 'surgery:schedule',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = withKey(request);
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const body = (await request.json().catch(() => null)) as Partial<Surgery> | null;
    if (
      !isString(body?.patientId) ||
      !isString(body.roomId) ||
      !isString(body.surgeonId) ||
      !isString(body.procedure) ||
      !timesOk(body.startsAt, body.endsAt)
    ) {
      return invalid();
    }
    const replyKey = `${access.tenantId}:${key}`;
    const known = replies.get(replyKey);
    const existing = known ? surgeries.find((s) => s.id === known) : undefined;
    if (existing) return HttpResponse.json(existing, { status: 201 });
    const room = rooms.find((r) => r.id === body.roomId && r.tenantId === access.tenantId);
    if (!room || room.archived) return error(422, 'unknown_room', 'No such theatre in use');
    const refused = clash(access.tenantId, body as Surgery);
    if (refused) return refused;
    created += 1;
    const made: Surgery = {
      id: `sur_new_${created}`,
      tenantId: access.tenantId,
      roomId: body.roomId,
      surgeonId: body.surgeonId,
      patientId: body.patientId,
      ...(body.serviceId ? { serviceId: body.serviceId } : {}),
      procedure: body.procedure,
      ...(body.notes ? { notes: body.notes } : {}),
      startsAt: body.startsAt as string,
      endsAt: body.endsAt as string,
      status: 'scheduled',
      version: 1,
    };
    surgeries.push(made);
    replies.set(replyKey, made.id);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.post('*/api/theatre/surgeries/:surgeryId/reschedule', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'surgery:schedule',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      roomId?: string;
      surgeonId?: string;
      startsAt?: string;
      endsAt?: string;
      version?: unknown;
    } | null;
    if (typeof body?.version !== 'number' || !timesOk(body.startsAt, body.endsAt)) {
      return invalid();
    }
    const row = surgeries.find((s) => s.id === params.surgeryId && s.tenantId === access.tenantId);
    if (!row) return error(404, 'surgery_not_found', 'No such surgery');
    if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
    if (row.status !== 'scheduled') return error(409, 'invalid_transition', 'Not scheduled');
    const next = {
      roomId: body.roomId ?? row.roomId,
      surgeonId: body.surgeonId ?? row.surgeonId,
      startsAt: body.startsAt as string,
      endsAt: body.endsAt as string,
    };
    const refused = clash(access.tenantId, { ...next, patientId: row.patientId }, row.id);
    if (refused) return refused;
    Object.assign(row, next, { version: row.version + 1 });
    return HttpResponse.json(row);
  }),

  ...(['start', 'complete', 'cancel'] as const).map((verb) =>
    http.post(`*/api/theatre/surgeries/:surgeryId/${verb}`, async ({ request, params }) => {
      const access = authorize(request, {
        permission: verb === 'cancel' ? 'surgery:schedule' : 'surgery:perform',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in access) return access.denied;
      const body = (await request.json().catch(() => null)) as {
        version?: unknown;
        reason?: unknown;
      } | null;
      if (typeof body?.version !== 'number' || (verb === 'cancel' && !isString(body.reason))) {
        return invalid();
      }
      const row = surgeries.find(
        (s) => s.id === params.surgeryId && s.tenantId === access.tenantId,
      );
      if (!row) return error(404, 'surgery_not_found', 'No such surgery');
      if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
      const to: Status =
        verb === 'start' ? 'in_progress' : verb === 'complete' ? 'completed' : 'cancelled';
      if (!MOVES[row.status].includes(to)) {
        return error(409, 'invalid_transition', 'That move is not allowed');
      }
      const now = new Date().toISOString();
      if (to === 'in_progress') row.startedAt = now;
      if (to === 'completed') row.completedAt = now;
      if (to === 'cancelled') row.cancelledAt = now;
      Object.assign(row, { status: to, version: row.version + 1 });
      return HttpResponse.json(row);
    }),
  ),
];
