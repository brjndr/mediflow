import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { admitMockFromEmergency } from './admissions-flow';
import { closeMockEmergencyEncounter, openMockEmergencyEncounter } from './clinical';
import { mockPatient } from './patients';

type Case = components['schemas']['EmergencyCase'];
type Create = components['schemas']['EmergencyCaseCreate'];
type Note = components['schemas']['EmergencyNote'];
type Mlc = components['schemas']['EmergencyMlc'];
type MlcSave = components['schemas']['EmergencyMlcSave'];

const FEATURE_FLAG = 'emergency';
const SEXES = ['male', 'female', 'other', 'unknown'];
const MODES = ['walk_in', 'ambulance', 'police', 'referred'];
const DISPOSITIONS = ['discharge', 'admit', 'refer', 'expired'];

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * At the hospital: a very urgent patient past the ten-minute target, an unidentified arrival not
 * yet triaged, a less urgent one and one already in treatment. Nothing at the clinic (the module
 * is off there).
 */
const seed = (): Case[] => [
  {
    id: 'er_1',
    tenantId: TENANT_IDS.hospital,
    tempId: 'ER-0001',
    patientId: 'pth_00002',
    sex: 'unknown',
    complaint: 'Chest pain',
    arrivalMode: 'ambulance',
    category: 2,
    status: 'waiting',
    arrivedAt: minutesAgo(25),
    triagedAt: minutesAgo(24),
    medicoLegal: false,
    version: 2,
  },
  {
    id: 'er_2',
    tenantId: TENANT_IDS.hospital,
    tempId: 'ER-0002',
    alias: 'Man in blue jacket',
    sex: 'male',
    approximateAge: 40,
    complaint: 'Road accident',
    arrivalMode: 'police',
    status: 'waiting',
    arrivedAt: minutesAgo(3),
    medicoLegal: false,
    version: 1,
  },
  {
    id: 'er_3',
    tenantId: TENANT_IDS.hospital,
    tempId: 'ER-0003',
    alias: 'Girl with a cut hand',
    sex: 'female',
    approximateAge: 9,
    complaint: 'Deep cut on the hand',
    arrivalMode: 'walk_in',
    category: 4,
    status: 'waiting',
    arrivedAt: minutesAgo(10),
    triagedAt: minutesAgo(8),
    medicoLegal: false,
    version: 2,
  },
  {
    id: 'er_4',
    tenantId: TENANT_IDS.hospital,
    tempId: 'ER-0004',
    alias: 'Woman, short of breath',
    sex: 'female',
    approximateAge: 60,
    complaint: 'Difficulty breathing',
    arrivalMode: 'walk_in',
    category: 3,
    status: 'in_treatment',
    arrivedAt: minutesAgo(50),
    triagedAt: minutesAgo(48),
    medicoLegal: false,
    version: 3,
  },
];

let cases = seed();
let created = 0;
let notes: Note[] = [];
/** The revisions of each case's medico-legal record, oldest first. */
let mlcRevisions = new Map<string, Mlc[]>();
let mlcPrints: { tenantId: string; caseId: string; revision: number }[] = [];
/** The prints of medico-legal records recorded so far, for tests. */
export const mockMlcPrints = () => mlcPrints;
const mlcPrintKeys = new Set<string>();
const noteReplies = new Map<string, string>();
/** What each Idempotency-Key was answered with, by hospital and key. */
const replies = new Map<string, string>();
onMockReset(() => {
  cases = seed();
  created = 0;
  notes = [];
  mlcRevisions = new Map();
  mlcPrints = [];
  mlcPrintKeys.clear();
  noteReplies.clear();
  replies.clear();
});

/** Untriaged first, then the most urgent category, then the longest wait. */
const byUrgency = (a: Case, b: Case) =>
  (a.category ?? 0) - (b.category ?? 0) || a.arrivedAt.localeCompare(b.arrivedAt);

const withKey = (request: Request) => request.headers.get('Idempotency-Key');
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const emergencyHandlers = [
  http.get('*/api/emergency/cases', ({ request }) => {
    const access = authorize(request, { permission: 'emergency:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const status = query.get('status');
    const all = cases
      .filter(
        (row) =>
          row.tenantId === access.tenantId &&
          (status ? row.status === status : row.status !== 'disposed'),
      )
      .sort(byUrgency);
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
  }),

  http.post('*/api/emergency/cases', async ({ request }) => {
    const access = authorize(request, {
      permission: 'emergency:register',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = withKey(request);
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const body = (await request.json().catch(() => null)) as Partial<Create> | null;
    if (
      typeof body?.complaint !== 'string' ||
      body.complaint.trim() === '' ||
      !MODES.includes(body.arrivalMode as string) ||
      (body.sex !== undefined && !SEXES.includes(body.sex)) ||
      (body.category !== undefined && !isInt(body.category, 1, 5)) ||
      (body.approximateAge !== undefined && !isInt(body.approximateAge, 0, 130))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const replyKey = `${access.tenantId}:${key}`;
    const known = replies.get(replyKey);
    const existing = known ? cases.find((row) => row.id === known) : undefined;
    if (existing) return HttpResponse.json(existing, { status: 201 });
    if (body.patientId !== undefined && !mockPatient(access.tenantId, body.patientId)) {
      return error(404, 'unknown_patient', 'No such patient');
    }
    created += 1;
    const arrivedAt = new Date().toISOString();
    const made: Case = {
      id: `er_new_${created}`,
      tenantId: access.tenantId,
      tempId: `ER-${String(4 + created).padStart(4, '0')}`,
      ...(body.patientId !== undefined ? { patientId: body.patientId } : {}),
      ...(body.alias ? { alias: body.alias } : {}),
      sex: body.sex ?? 'unknown',
      ...(body.approximateAge !== undefined ? { approximateAge: body.approximateAge } : {}),
      complaint: body.complaint.trim(),
      arrivalMode: body.arrivalMode as Case['arrivalMode'],
      ...(body.category !== undefined ? { category: body.category, triagedAt: arrivedAt } : {}),
      status: 'waiting',
      arrivedAt,
      medicoLegal: false,
      version: 1,
    };
    cases.push(made);
    replies.set(replyKey, made.id);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.post('*/api/emergency/cases/:caseId/triage', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'emergency:triage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      category?: unknown;
      version?: unknown;
    } | null;
    if (!isInt(body?.category, 1, 5) || typeof body?.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
    if (row.status === 'disposed') return error(409, 'invalid_transition', 'The patient has left');
    Object.assign(row, {
      category: body.category,
      triagedAt: new Date().toISOString(),
      version: row.version + 1,
    });
    return HttpResponse.json(row);
  }),

  http.post('*/api/emergency/cases/:caseId/identify', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'emergency:register',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      patientId?: unknown;
      version?: unknown;
    } | null;
    if (typeof body?.patientId !== 'string' || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
    if (row.patientId) return error(409, 'already_identified', 'Already linked');
    if (!mockPatient(access.tenantId, body.patientId)) {
      return error(404, 'unknown_patient', 'No such patient');
    }
    Object.assign(row, { patientId: body.patientId, version: row.version + 1 });
    return HttpResponse.json(row);
  }),
  http.get('*/api/emergency/cases/:caseId', ({ request, params }) => {
    const access = authorize(request, { permission: 'emergency:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    return row ? HttpResponse.json(row) : error(404, 'case_not_found', 'No such case');
  }),

  http.post('*/api/emergency/cases/:caseId/start', async ({ request, params }) => {
    const access = authorize(request, { permission: 'emergency:care', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as { version?: unknown } | null;
    if (typeof body?.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
    if (row.status !== 'waiting') return error(409, 'invalid_transition', 'Already started');
    Object.assign(row, { status: 'in_treatment', version: row.version + 1 });
    return HttpResponse.json(row);
  }),

  http.post('*/api/emergency/cases/:caseId/encounter', async ({ request, params }) => {
    const access = authorize(request, { permission: 'emergency:care', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as { version?: unknown } | null;
    if (typeof body?.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
    if (row.status === 'disposed') return error(409, 'invalid_transition', 'The patient has left');
    if (row.encounterId) return HttpResponse.json(row);
    if (!row.patientId) return error(409, 'identify_first', 'Link the patient to a record first');
    Object.assign(row, {
      encounterId: openMockEmergencyEncounter(access.tenantId, row.patientId),
      status: 'in_treatment',
      version: row.version + 1,
    });
    return HttpResponse.json(row);
  }),

  http.get('*/api/emergency/cases/:caseId/notes', ({ request, params }) => {
    const access = authorize(request, { permission: 'emergency:care', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    const all = notes.filter((note) => note.caseId === row.id);
    const query = new URL(request.url).searchParams;
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const start = cursor ? all.findIndex((note) => note.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    return HttpResponse.json({
      items: all.slice(start, start + limit),
      nextCursor: next ? next.id : null,
    });
  }),

  http.post('*/api/emergency/cases/:caseId/notes', async ({ request, params }) => {
    const access = authorize(request, { permission: 'emergency:care', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = withKey(request);
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const body = (await request.json().catch(() => null)) as {
      kind?: unknown;
      body?: unknown;
    } | null;
    if (
      (body?.kind !== 'observation' && body?.kind !== 'assessment') ||
      typeof body.body !== 'string' ||
      body.body.trim() === ''
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    const replyKey = `${access.tenantId}:${key}`;
    const known = noteReplies.get(replyKey);
    const existing = known ? notes.find((note) => note.id === known) : undefined;
    if (existing) return HttpResponse.json(existing, { status: 201 });
    if (row.status === 'disposed') return error(409, 'invalid_transition', 'The patient has left');
    const made: Note = {
      id: `ern_${notes.length + 1}`,
      caseId: row.id,
      kind: body.kind,
      body: body.body.trim(),
      authorName: currentSession()?.user.name ?? '',
      createdAt: new Date().toISOString(),
    };
    notes.push(made);
    noteReplies.set(replyKey, made.id);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.get('*/api/emergency/cases/:caseId/medico-legal', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'medicoLegal:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    const latest = mlcRevisions.get(row.id)?.at(-1);
    return latest
      ? HttpResponse.json(latest)
      : error(404, 'not_medico_legal', 'The case is not medico-legal');
  }),

  http.post('*/api/emergency/cases/:caseId/medico-legal/print', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'medicoLegal:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = withKey(request);
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    const latest = mlcRevisions.get(row.id)?.at(-1);
    if (!latest) return error(404, 'not_medico_legal', 'The case is not medico-legal');
    const keyOf = `${access.tenantId}:${key}`;
    if (!mlcPrintKeys.has(keyOf)) {
      mlcPrintKeys.add(keyOf);
      mlcPrints.push({ tenantId: access.tenantId, caseId: row.id, revision: latest.revision });
    }
    return HttpResponse.json(latest);
  }),

  http.put('*/api/emergency/cases/:caseId/medico-legal', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'medicoLegal:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (!withKey(request)) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body = (await request.json().catch(() => null)) as Partial<MlcSave> | null;
    if (
      !body ||
      typeof body.revision !== 'number' ||
      typeof body.category !== 'string' ||
      typeof body.narrative !== 'string' ||
      body.narrative.trim() === '' ||
      typeof body.policeInformed !== 'boolean'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    if (body.policeInformed && !body.policeStation?.trim()) {
      return error(422, 'police_station_required', 'Name the police station informed');
    }
    const history = mlcRevisions.get(row.id) ?? [];
    if (history.length !== body.revision) {
      return error(409, 'version_conflict', 'The record has changed since it was read');
    }
    const made: Mlc = {
      caseId: row.id,
      revision: history.length + 1,
      category: body.category as Mlc['category'],
      narrative: body.narrative.trim(),
      ...(body.broughtBy ? { broughtBy: body.broughtBy.trim() } : {}),
      policeInformed: body.policeInformed,
      ...(body.policeInformed && body.policeStation
        ? { policeStation: body.policeStation.trim() }
        : {}),
      ...(body.policeReference ? { policeReference: body.policeReference.trim() } : {}),
      recordedByName: currentSession()?.user.name ?? '',
      recordedAt: new Date().toISOString(),
    };
    mlcRevisions.set(row.id, [...history, made]);
    row.medicoLegal = true;
    return HttpResponse.json(made);
  }),

  http.post('*/api/emergency/cases/:caseId/disposition', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'emergency:dispose',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      version?: unknown;
      type?: unknown;
      note?: unknown;
      destination?: unknown;
      deathAt?: unknown;
      doctorId?: unknown;
    } | null;
    if (
      typeof body?.version !== 'number' ||
      !DISPOSITIONS.includes(body.type as string) ||
      (body.note !== undefined && typeof body.note !== 'string')
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = cases.find((one) => one.id === params.caseId && one.tenantId === access.tenantId);
    if (!row) return error(404, 'case_not_found', 'No such case');
    if (row.version !== body.version) return error(409, 'version_conflict', 'It has changed');
    if (row.status === 'disposed') return error(409, 'invalid_transition', 'The patient has left');
    const type = body.type as NonNullable<Case['disposition']>;
    if (type === 'refer' && (typeof body.destination !== 'string' || !body.destination.trim())) {
      return error(422, 'destination_required', 'Say where the patient is referred to');
    }
    if (type === 'expired') {
      if (typeof body.deathAt !== 'string') {
        return error(422, 'death_time_required', 'Give the time of death');
      }
      if (Date.parse(body.deathAt) > Date.now() + 60_000) {
        return error(422, 'death_in_future', 'The time of death is in the future');
      }
    }
    let admissionId: string | undefined;
    if (type === 'admit') {
      if (!row.patientId) return error(409, 'identify_first', 'Link the patient to a record first');
      const admitted = admitMockFromEmergency(
        access.tenantId,
        row.patientId,
        typeof body.note === 'string' ? body.note : undefined,
        typeof body.doctorId === 'string' ? body.doctorId : undefined,
      );
      if ('code' in admitted) {
        return error(admitted.code === 'unknown_doctor' ? 422 : 409, admitted.code, 'Not admitted');
      }
      admissionId = admitted.id;
    }
    if (row.encounterId) closeMockEmergencyEncounter(row.encounterId);
    Object.assign(row, {
      status: 'disposed',
      disposition: type,
      disposedAt: new Date().toISOString(),
      ...(typeof body.note === 'string' && body.note.trim()
        ? { dispositionNote: body.note.trim() }
        : {}),
      ...(type === 'refer' ? { destination: String(body.destination).trim() } : {}),
      ...(type === 'expired' ? { deathAt: String(body.deathAt) } : {}),
      ...(admissionId ? { admissionId } : {}),
      version: row.version + 1,
    });
    return HttpResponse.json(row);
  }),
];
