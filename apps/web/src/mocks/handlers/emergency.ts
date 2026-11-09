import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockPatient } from './patients';

type Case = components['schemas']['EmergencyCase'];
type Create = components['schemas']['EmergencyCaseCreate'];

const FEATURE_FLAG = 'emergency';
const SEXES = ['male', 'female', 'other', 'unknown'];
const MODES = ['walk_in', 'ambulance', 'police', 'referred'];

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
    version: 3,
  },
];

let cases = seed();
let created = 0;
/** What each Idempotency-Key was answered with, by hospital and key. */
const replies = new Map<string, string>();
onMockReset(() => {
  cases = seed();
  created = 0;
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
];
