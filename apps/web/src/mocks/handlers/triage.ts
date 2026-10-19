import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import { todayIn } from '@/shared/utils/timezone';
import { currentSession, mockTenantTimezone, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockPatient, mockPatientDob } from './patients';
import { mockQueueToken } from './queue';

type Vitals = components['schemas']['Vitals'];
type VitalsPage = components['schemas']['VitalsPage'];
type VitalRanges = components['schemas']['VitalRanges'];
type AllergyList = components['schemas']['AllergyList'];
type Allergy = components['schemas']['Allergy'];

const FEATURE_FLAG = 'triage';
const READ = 'vitals:read';
const RECORD = 'vitals:record';
const ALLERGY_READ = 'allergy:read';
const ALLERGY_UPDATE = 'allergy:update';
const SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'];

/** What a body can be, as the API takes it: not what is normal, which the ranges say. */
const LIMITS = {
  systolic: { min: 40, max: 300, whole: true },
  diastolic: { min: 20, max: 200, whole: true },
  pulse: { min: 20, max: 300, whole: true },
  temperature: { min: 25, max: 45, whole: false },
  spo2: { min: 50, max: 100, whole: true },
  weight: { min: 0.3, max: 400, whole: false },
  height: { min: 20, max: 250, whole: false },
} as const;
type Measure = keyof typeof LIMITS;
const MEASURES = Object.keys(LIMITS) as Measure[];

/** Each hospital's adult ranges: the clinic marks a temperature high a little sooner. */
const RANGES: Record<string, NonNullable<VitalRanges['ranges']>> = {
  [TENANT_IDS.hospital]: {
    systolic: { low: 90, high: 139 },
    diastolic: { low: 60, high: 89 },
    pulse: { low: 60, high: 100 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
  [TENANT_IDS.clinic]: {
    systolic: { low: 90, high: 139 },
    diastolic: { low: 60, high: 89 },
    pulse: { low: 60, high: 100 },
    temperature: { low: 36.1, high: 37.5 },
    spo2: { low: 94 },
  },
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/**
 * Readings at each hospital: at the hospital, two of its first patient (the newer one with a high
 * blood pressure and pulse) and one of the patient being served in the queue; at the clinic, one
 * of its first patient. Synthetic, as everything in the mock.
 */
function seedVitals(): Vitals[] {
  const hospital = TENANT_IDS.hospital;
  const clinic = TENANT_IDS.clinic;
  return [
    {
      id: 'vit_h_1',
      tenantId: hospital,
      patientId: 'pth_00001',
      recordedAt: hoursAgo(24 * 30),
      recordedById: 'user_doctor',
      recordedByName: 'Sample Doctor',
      systolic: 122,
      diastolic: 78,
      pulse: 72,
      temperature: 36.8,
      spo2: 98,
      weight: 64.5,
      height: 162,
    },
    {
      id: 'vit_h_2',
      tenantId: hospital,
      patientId: 'pth_00001',
      recordedAt: hoursAgo(2),
      recordedById: 'user_doctor',
      recordedByName: 'Sample Doctor',
      systolic: 152,
      diastolic: 94,
      pulse: 108,
      temperature: 37.2,
      spo2: 97,
      chiefComplaint: 'Headache for two days.',
    },
    {
      id: 'vit_c_1',
      tenantId: clinic,
      patientId: 'ptc_00001',
      recordedAt: hoursAgo(5),
      recordedById: 'user_doctor',
      recordedByName: 'Sample Doctor',
      pulse: 80,
      temperature: 37.6,
    },
  ];
}

interface StoredAllergies {
  tenantId: string;
  patientId: string;
  status: 'none' | 'listed';
  items: Allergy[];
  version: number;
  updatedAt: string;
  updatedByName: string;
}

function seedAllergies(): StoredAllergies[] {
  return [
    {
      tenantId: TENANT_IDS.hospital,
      patientId: 'pth_00001',
      status: 'listed',
      items: [{ substance: 'Penicillin', reaction: 'Rash', severity: 'severe' }],
      version: 1,
      updatedAt: hoursAgo(24 * 30),
      updatedByName: 'Sample Doctor',
    },
    {
      tenantId: TENANT_IDS.clinic,
      patientId: 'ptc_00001',
      status: 'none',
      items: [],
      version: 1,
      updatedAt: hoursAgo(5),
      updatedByName: 'Sample Doctor',
    },
  ];
}

let vitals = seedVitals();
let allergies = seedAllergies();
let counter = 0;
/** Readings already recorded, by tenant, user and idempotency key, as the API keeps them. */
let answered = new Map<string, { body: string; reading: Vitals }>();

onMockReset(() => {
  vitals = seedVitals();
  allergies = seedAllergies();
  counter = 0;
  answered = new Map();
});

/** Whether a patient was under 18 at the hospital's date: no ranges apply to them yet (#379). */
function isChild(tenantId: string, patientId: string) {
  const dob = mockPatientDob(tenantId, patientId);
  if (!dob) return false;
  const today = todayIn(mockTenantTimezone(tenantId));
  const eighteenth = `${String(Number(dob.slice(0, 4)) + 18).padStart(4, '0')}${dob.slice(4)}`;
  return today < eighteenth;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Why a reading's body is refused, or null when the API takes it. */
function invalidReading(body: Record<string, unknown>): string | null {
  const allowed = new Set([
    ...MEASURES,
    'chiefComplaint',
    'queueTokenId',
    'correctsId',
    'correctionReason',
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return 'Unknown field';
  for (const name of MEASURES) {
    const value = body[name];
    if (value === undefined) continue;
    const { min, max, whole } = LIMITS[name];
    if (typeof value !== 'number' || value < min || value > max) return `Bad ${name}`;
    if (whole ? !Number.isInteger(value) : Math.round(value * 10) !== value * 10)
      return `Bad ${name}`;
  }
  const complaint = body.chiefComplaint;
  if (
    complaint !== undefined &&
    (typeof complaint !== 'string' ||
      complaint.length < 1 ||
      complaint.length > 500 ||
      !PLAIN_LINES.test(complaint))
  ) {
    return 'Bad chief complaint';
  }
  if (MEASURES.every((name) => body[name] === undefined) && complaint === undefined) {
    return 'At least one measurement or the chief complaint';
  }
  if ((body.systolic === undefined) !== (body.diastolic === undefined)) return 'Both pressures';
  if (
    typeof body.systolic === 'number' &&
    typeof body.diastolic === 'number' &&
    body.diastolic >= body.systolic
  ) {
    return 'Diastolic below systolic';
  }
  const reason = body.correctionReason;
  if ((body.correctsId === undefined) !== (reason === undefined))
    return 'A correction needs a reason';
  if (
    reason !== undefined &&
    (typeof reason !== 'string' || reason.length > 200 || !PLAIN_TEXT.test(reason))
  ) {
    return 'Bad reason';
  }
  return null;
}

function allergyView(tenantId: string, patientId: string): AllergyList {
  const stored = allergies.find(
    (each) => each.tenantId === tenantId && each.patientId === patientId,
  );
  if (!stored) return { tenantId, patientId, status: 'unknown', items: [], version: 0 };
  return structuredClone(stored);
}

function invalidAllergies(body: Record<string, unknown>): string | null {
  const { version, status, items } = body;
  if (!Number.isInteger(version) || (version as number) < 0) return 'Bad version';
  if (status !== 'none' && status !== 'listed') return 'Bad status';
  if (!Array.isArray(items) || items.length > 50) return 'Bad items';
  if (status === 'none' ? items.length > 0 : items.length === 0)
    return 'Items do not match the status';
  for (const item of items as unknown[]) {
    if (!isObject(item)) return 'Bad item';
    const { substance, reaction, severity } = item;
    if (
      typeof substance !== 'string' ||
      !substance ||
      substance.length > 100 ||
      !PLAIN_TEXT.test(substance)
    ) {
      return 'Bad substance';
    }
    if (
      reaction !== undefined &&
      (typeof reaction !== 'string' ||
        !reaction ||
        reaction.length > 200 ||
        !PLAIN_TEXT.test(reaction))
    ) {
      return 'Bad reaction';
    }
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) return 'Bad severity';
  }
  return null;
}

/** The patient of this hospital, or the 404 the API gives for one it does not have. */
const unknownPatient = (tenantId: string, patientId: string) =>
  mockPatient(tenantId, patientId) ? null : error(404, 'not_found', 'Patient not found');

export const triageHandlers = [
  http.get('*/api/patients/:patientId/vitals', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const patientId = String(params.patientId);
    const missing = unknownPatient(tenantId, patientId);
    if (missing) return missing;
    const query = new URL(request.url).searchParams;
    const limit = Number(query.get('limit') ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return error(400, 'validation_failed', 'Bad limit');
    }
    const tokenId = query.get('queueTokenId');
    const cursor = query.get('cursor');
    const shown = vitals
      .filter((each) => each.tenantId === tenantId && each.patientId === patientId)
      .filter((each) => !tokenId || each.queueTokenId === tokenId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
    const first = cursor ? shown.findIndex((each) => each.id === cursor) : 0;
    if (first < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = shown[first + limit];
    return HttpResponse.json<VitalsPage>({
      items: shown.slice(first, first + limit),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: shown.length }),
    });
  }),

  http.get('*/api/patients/:patientId/vitals/:vitalsId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = vitals.find(
      (each) =>
        each.tenantId === access.tenantId &&
        each.patientId === String(params.patientId) &&
        each.id === String(params.vitalsId),
    );
    return found ? HttpResponse.json<Vitals>(found) : error(404, 'not_found', 'Reading not found');
  }),

  http.post('*/api/patients/:patientId/vitals', async ({ request, params }) => {
    const access = authorize(request, { permission: RECORD, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const patientId = String(params.patientId);
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body: unknown = await request.json().catch(() => null);
    const session = currentSession();
    const keyOf = `${tenantId}:${session?.user.id ?? ''}:${patientId}:${key}`;
    const replay = answered.get(keyOf);
    if (replay) {
      if (replay.body !== JSON.stringify(body)) {
        return error(422, 'idempotency_key_reuse', 'This key was used for a different request');
      }
      return HttpResponse.json<Vitals>(replay.reading, { status: 201 });
    }
    const missing = unknownPatient(tenantId, patientId);
    if (missing) return missing;
    if (!isObject(body)) return error(400, 'validation_failed', 'A reading is required');
    const invalid = invalidReading(body);
    if (invalid) return error(400, 'validation_failed', invalid);
    if (typeof body.queueTokenId === 'string') {
      const token = mockQueueToken(body.queueTokenId);
      const today = todayIn(mockTenantTimezone(tenantId));
      if (
        !token ||
        token.tenantId !== tenantId ||
        token.patientId !== patientId ||
        token.day !== today
      ) {
        return error(422, 'token_not_for_patient', "Not this patient's token today");
      }
    }
    // A correction takes the token and the encounter of the reading it corrects, and a reading
    // is corrected once: a later correction corrects the correction.
    let corrected: Vitals | undefined;
    if (typeof body.correctsId === 'string') {
      if (body.queueTokenId !== undefined) {
        return error(400, 'validation_failed', 'A correction takes the token of its reading');
      }
      corrected = vitals.find(
        (each) =>
          each.tenantId === tenantId && each.patientId === patientId && each.id === body.correctsId,
      );
      if (!corrected) return error(422, 'unknown_correction', "Not this patient's reading");
      if (vitals.some((each) => each.correctsId === body.correctsId)) {
        return error(422, 'already_corrected', 'That reading was already corrected');
      }
    }
    counter += 1;
    const reading: Vitals = {
      ...(body as Partial<Vitals>),
      ...(corrected?.queueTokenId ? { queueTokenId: corrected.queueTokenId } : {}),
      ...(corrected?.encounterId ? { encounterId: corrected.encounterId } : {}),
      id: `vit_new_${counter}`,
      tenantId,
      patientId,
      recordedAt: new Date().toISOString(),
      recordedById: session?.user.id ?? '',
      recordedByName: session?.user.name ?? '',
    };
    vitals.push(reading);
    answered.set(keyOf, { body: JSON.stringify(body), reading });
    return HttpResponse.json<Vitals>(reading, { status: 201 });
  }),

  http.get('*/api/patients/:patientId/vital-ranges', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const patientId = String(params.patientId);
    const missing = unknownPatient(tenantId, patientId);
    if (missing) return missing;
    return HttpResponse.json<VitalRanges>({
      ranges: isChild(tenantId, patientId) ? null : (RANGES[tenantId] ?? null),
    });
  }),

  http.get('*/api/patients/:patientId/allergies', ({ request, params }) => {
    const access = authorize(request, { permission: ALLERGY_READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    const missing = unknownPatient(access.tenantId, patientId);
    if (missing) return missing;
    return HttpResponse.json<AllergyList>(allergyView(access.tenantId, patientId));
  }),

  http.put('*/api/patients/:patientId/allergies', async ({ request, params }) => {
    const access = authorize(request, { permission: ALLERGY_UPDATE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const patientId = String(params.patientId);
    const body: unknown = await request.json().catch(() => null);
    const missing = unknownPatient(tenantId, patientId);
    if (missing) return missing;
    if (!isObject(body)) return error(400, 'validation_failed', 'Allergies are required');
    const invalid = invalidAllergies(body);
    if (invalid) return error(400, 'validation_failed', invalid);
    // Nothing awaited between the version check and the change, as a row lock decides it.
    const current = allergyView(tenantId, patientId);
    if (body.version !== current.version) return error(409, 'conflict', 'Changed by someone else');
    const stored: StoredAllergies = {
      tenantId,
      patientId,
      status: body.status as 'none' | 'listed',
      items: structuredClone(body.items as Allergy[]),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      updatedByName: currentSession()?.user.name ?? '',
    };
    allergies = [
      ...allergies.filter((each) => !(each.tenantId === tenantId && each.patientId === patientId)),
      stored,
    ];
    return HttpResponse.json<AllergyList>(allergyView(tenantId, patientId));
  }),
];

/** Changes a patient's allergies behind the screen, as another user would. */
export function editMockAllergies(tenantId: string, patientId: string, items: Allergy[]): void {
  const current = allergyView(tenantId, patientId);
  allergies = [
    ...allergies.filter((each) => !(each.tenantId === tenantId && each.patientId === patientId)),
    {
      tenantId,
      patientId,
      status: items.length > 0 ? 'listed' : 'none',
      items,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      updatedByName: 'Someone Else',
    },
  ];
}

/** The readings the mock holds for a patient, for tests to check what was recorded. */
export const mockVitalsOf = (tenantId: string, patientId: string) =>
  vitals.filter((each) => each.tenantId === tenantId && each.patientId === patientId);
