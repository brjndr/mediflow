import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { marHandlers } from './nursing-mar';

type WardVital = components['schemas']['WardVital'];
type Flags = NonNullable<WardVital['flags']>;
type Stored = WardVital & { key: string };

const FEATURE_FLAG = 'nursing';
const MEASURES = ['systolic', 'diastolic', 'pulse', 'temperature', 'spo2', 'weight', 'height'];

let readings: Stored[] = [];
let counter = 0;
onMockReset(() => {
  readings = [];
  counter = 0;
});

/** For tests: a reading already on a stay's chart. */
export function addMockWardVital(vital: Partial<WardVital> & { id: string; admissionId: string }) {
  readings.push({
    tenantId: TENANT_IDS.hospital,
    encounterId: 'enc_x',
    patientId: 'p_seed',
    observedAt: '2026-11-08T10:00:00.000Z',
    recordedAt: '2026-11-08T10:00:00.000Z',
    recordedById: 'user_nurse',
    recordedByName: 'Nurse Nandini',
    key: vital.id,
    ...vital,
  });
}

/** A few of the age band's ranges, enough to show a flag. */
function flagsOf(vital: Partial<WardVital>): Flags | undefined {
  const flags: Flags = {};
  const check = (name: keyof Flags, low: number, high: number) => {
    const value = vital[name];
    if (value === undefined) return;
    if (value < low) flags[name] = 'low';
    else if (value > high) flags[name] = 'high';
  };
  check('systolic', 90, 140);
  check('diastolic', 60, 90);
  check('pulse', 60, 100);
  check('temperature', 36.1, 37.5);
  check('spo2', 95, 100);
  return Object.keys(flags).length > 0 ? flags : undefined;
}

export const nursingHandlers = [
  ...marHandlers,
  http.get('*/api/admissions/:admissionId/vitals', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'nursingVitals:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const all = readings
      .filter(
        (each) => each.tenantId === access.tenantId && each.admissionId === params.admissionId,
      )
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .map(({ key: _key, ...each }) => each);
    const start = cursor ? all.findIndex((each) => each.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    return HttpResponse.json({
      items: all.slice(start, start + limit),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: all.length }),
    });
  }),

  http.post('*/api/admissions/:admissionId/vitals', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'nursingVitals:record',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const repeat = readings.find(
      (each) =>
        each.key === key &&
        each.tenantId === access.tenantId &&
        each.admissionId === params.admissionId,
    );
    if (repeat) return HttpResponse.json(repeat, { status: 201 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !MEASURES.some((name) => typeof body[name] === 'number')) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    counter += 1;
    const now = new Date().toISOString();
    const vital: Stored = {
      id: `wv_${counter}`,
      tenantId: access.tenantId,
      admissionId: String(params.admissionId),
      encounterId: 'enc_x',
      patientId: 'p_seed',
      observedAt: typeof body.observedAt === 'string' ? body.observedAt : now,
      recordedAt: now,
      recordedById: currentSession()?.user.id ?? '',
      recordedByName: currentSession()?.user.name ?? '',
      key,
    };
    for (const name of MEASURES) {
      const value = body[name];
      if (typeof value === 'number') (vital as Record<string, unknown>)[name] = value;
    }
    const flags = flagsOf(vital);
    if (flags) vital.flags = flags;
    readings.push(vital);
    return HttpResponse.json(vital, { status: 201 });
  }),

  http.post(
    '*/api/admissions/:admissionId/vitals/:vitalId/correct',
    async ({ request, params }) => {
      const access = authorize(request, {
        permission: 'nursingVitals:record',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in access) return access.denied;
      const key = request.headers.get('idempotency-key');
      if (key === null) {
        return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
      }
      const repeat = readings.find(
        (each) =>
          each.key === key &&
          each.tenantId === access.tenantId &&
          each.admissionId === params.admissionId,
      );
      if (repeat) return HttpResponse.json(repeat, { status: 201 });
      const original = readings.find(
        (each) =>
          each.id === params.vitalId &&
          each.tenantId === access.tenantId &&
          each.admissionId === params.admissionId,
      );
      if (!original) return error(404, 'vital_not_found', 'No such reading');
      if (original.correctedById) return error(422, 'already_corrected', 'Already corrected');
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body.reason !== 'string' || body.reason === '') {
        return error(400, 'validation_failed', 'The request is not valid');
      }
      counter += 1;
      const correction: Stored = {
        id: `wv_${counter}`,
        tenantId: access.tenantId,
        admissionId: original.admissionId,
        encounterId: original.encounterId,
        patientId: original.patientId,
        observedAt: original.observedAt,
        recordedAt: new Date().toISOString(),
        recordedById: currentSession()?.user.id ?? '',
        recordedByName: currentSession()?.user.name ?? '',
        correctsId: original.id,
        correctionReason: body.reason,
        key,
      };
      for (const name of MEASURES) {
        const value = body[name];
        if (typeof value === 'number') (correction as Record<string, unknown>)[name] = value;
      }
      const flags = flagsOf(correction);
      if (flags) correction.flags = flags;
      original.correctedById = correction.id;
      readings.push(correction);
      return HttpResponse.json(correction, { status: 201 });
    },
  ),
];
