import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import { todayIn } from '@/shared/utils/timezone';
import { currentSession, mockTenantTimezone, onMockReset, TENANT_IDS } from '../db';
import { authorize, error, searchBody } from '../respond';
import { mockDrugsOf } from './drugs';
import { mockPatient, mockPatientDob } from './patients';
import { mockQueueToken } from './queue';

type Vitals = components['schemas']['Vitals'];
type VitalsPage = components['schemas']['VitalsPage'];
type VitalRanges = components['schemas']['VitalRanges'];
type VitalRangeTable = components['schemas']['VitalRangeTable'];
type RangeSet = components['schemas']['VitalRangeSet'];
type AllergyList = components['schemas']['AllergyList'];
type Allergy = components['schemas']['Allergy'];

const FEATURE_FLAG = 'triage';
const READ = 'vitals:read';
const RECORD = 'vitals:record';
const CONFIGURE = 'vitals:configure';
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

const BANDS = ['infant', 'child', 'adolescent', 'adult'] as const;
type Band = (typeof BANDS)[number];
const RANGED = ['systolic', 'diastolic', 'pulse', 'temperature', 'spo2'] as const;

/** The built-in ranges of each band, as the API has them. */
const DEFAULT_BANDS: Record<Band, RangeSet> = {
  infant: {
    systolic: { low: 70, high: 100 },
    diastolic: { low: 40, high: 65 },
    pulse: { low: 100, high: 160 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
  child: {
    systolic: { low: 80, high: 120 },
    diastolic: { low: 50, high: 80 },
    pulse: { low: 70, high: 130 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
  adolescent: {
    systolic: { low: 90, high: 130 },
    diastolic: { low: 55, high: 85 },
    pulse: { low: 60, high: 105 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
  adult: {
    systolic: { low: 90, high: 139 },
    diastolic: { low: 60, high: 89 },
    pulse: { low: 60, high: 100 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
};

/** Each hospital's ranges: the clinic marks a temperature high a little sooner for adults. */
function seedRanges(): Record<string, VitalRangeTable> {
  return {
    [TENANT_IDS.hospital]: { version: 0, bands: structuredClone(DEFAULT_BANDS) },
    [TENANT_IDS.clinic]: {
      version: 1,
      bands: {
        ...structuredClone(DEFAULT_BANDS),
        adult: {
          ...DEFAULT_BANDS.adult,
          temperature: { low: 36.1, high: 37.5 },
          spo2: { low: 94 },
        },
      },
    },
  };
}

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

let ranges = seedRanges();
let vitals = seedVitals().map(stamped);
let allergies = seedAllergies();
let counter = 0;
/** Readings already recorded, by tenant, user and idempotency key, as the API keeps them. */
let answered = new Map<string, { body: string; reading: Vitals }>();

onMockReset(() => {
  ranges = seedRanges();
  vitals = seedVitals().map(stamped);
  allergies = seedAllergies();
  counter = 0;
  answered = new Map();
});

/** The age band a patient is in at the hospital's date, or null when their birth date is unknown. */
function bandOf(tenantId: string, patientId: string): Band | null {
  const dob = mockPatientDob(tenantId, patientId);
  if (!dob) return null;
  const today = todayIn(mockTenantTimezone(tenantId));
  const years = (until: string) => {
    const age = Number(until.slice(0, 4)) - Number(dob.slice(0, 4));
    return until.slice(5) < dob.slice(5) ? age - 1 : age;
  };
  const age = years(today);
  return age >= 18 ? 'adult' : age >= 12 ? 'adolescent' : age >= 1 ? 'child' : 'infant';
}

/** What is out of range in a reading, against the ranges in force now: stored with the reading. */
function flagsOf(tenantId: string, patientId: string, reading: Partial<Vitals>) {
  const band = bandOf(tenantId, patientId);
  const set = band ? ranges[tenantId]?.bands[band] : undefined;
  const flags: NonNullable<Vitals['flags']> = {};
  for (const measure of RANGED) {
    const value = reading[measure];
    const limits = set?.[measure];
    if (value === undefined || !limits) continue;
    if (limits.low !== undefined && value < limits.low) flags[measure] = 'low';
    else if (limits.high !== undefined && value > limits.high) flags[measure] = 'high';
  }
  return flags;
}

function stamped(reading: Vitals): Vitals {
  return { ...reading, flags: flagsOf(reading.tenantId, reading.patientId, reading) };
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

type Allergen = components['schemas']['Allergen'];
type AllergenKind = Allergen['kind'];

/**
 * The shared allergen catalog (#380), a few of its entries. Like the API's it belongs to no
 * hospital; a medicine is found in the hospital's own drug catalog.
 */
const CATALOG: readonly { id: string; name: string; kind: AllergenKind; members: string[] }[] = [
  {
    id: 'alg_00001',
    name: 'Penicillins',
    kind: 'drug_class',
    members: ['penicillin', 'amoxicillin', 'ampicillin', 'cloxacillin', 'piperacillin'],
  },
  {
    id: 'alg_00002',
    name: 'Sulfonamides (sulfa drugs)',
    kind: 'drug_class',
    members: ['sulfamethoxazole', 'sulfadiazine', 'co-trimoxazole'],
  },
  {
    id: 'alg_00003',
    name: 'NSAIDs (anti-inflammatory painkillers)',
    kind: 'drug_class',
    members: ['ibuprofen', 'diclofenac', 'aspirin', 'naproxen'],
  },
  { id: 'alg_00004', name: 'Peanuts', kind: 'food', members: [] },
  { id: 'alg_00005', name: 'Shellfish', kind: 'food', members: [] },
  { id: 'alg_00006', name: 'Latex', kind: 'other', members: [] },
];

/** What an allergy that names a catalog entry or a medicine is stored as, or null if unknown. */
function codedAllergy(tenantId: string, item: Record<string, unknown>): Allergy | 'unknown' | null {
  const { allergenId, drugId } = item;
  if (typeof allergenId === 'string') {
    const found = CATALOG.find((each) => each.id === allergenId);
    return found
      ? {
          substance: found.name,
          severity: item.severity as Allergy['severity'],
          kind: found.kind,
          allergenId: found.id,
          members: found.members,
        }
      : 'unknown';
  }
  if (typeof drugId === 'string') {
    const found = mockDrugsOf(tenantId).find(
      (each) => each.id === drugId && each.type === 'medicine' && !each.archived,
    );
    return found
      ? {
          substance: found.genericName,
          severity: item.severity as Allergy['severity'],
          kind: 'drug',
          drugId: found.id,
          members: [
            found.genericName
              .toLowerCase()
              .replace(/[^\p{L}\p{N}-]+/gu, ' ')
              .trim(),
          ],
        }
      : 'unknown';
  }
  return null;
}

/** The patient of this hospital, or the 404 the API gives for one it does not have. */
const unknownPatient = (tenantId: string, patientId: string) =>
  mockPatient(tenantId, patientId) ? null : error(404, 'not_found', 'Patient not found');

export const triageHandlers = [
  http.post('*/api/allergens/search', async ({ request }) => {
    const access = authorize(request, { permission: ALLERGY_READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = await searchBody(request);
    const words = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const kind = params.get('kind');
    const limit = Number(params.get('limit') ?? 25);
    const named = (name: string) => words.every((word) => name.toLowerCase().includes(word));
    const found: Allergen[] = [];
    if (kind !== 'drug') {
      for (const entry of CATALOG) {
        if ((!kind || entry.kind === kind) && named(entry.name)) {
          found.push({ name: entry.name, kind: entry.kind, allergenId: entry.id });
        }
      }
    }
    if (!kind || kind === 'drug') {
      const seen = new Set<string>();
      for (const drug of mockDrugsOf(access.tenantId)) {
        const key = drug.genericName.toLowerCase();
        if (drug.type !== 'medicine' || drug.archived || seen.has(key) || !named(key)) continue;
        seen.add(key);
        found.push({ name: drug.genericName, kind: 'drug', drugId: drug.id });
      }
    }
    found.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return HttpResponse.json({ items: found.slice(0, limit), nextCursor: null });
  }),

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
      flags: flagsOf(tenantId, patientId, body as Partial<Vitals>),
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
    const band = bandOf(tenantId, patientId);
    return HttpResponse.json<VitalRanges>({
      ranges: band ? (ranges[tenantId]?.bands[band] ?? null) : null,
    });
  }),

  http.get('*/api/vitals/ranges', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    return HttpResponse.json<VitalRangeTable>(
      structuredClone(ranges[access.tenantId] ?? { version: 0, bands: DEFAULT_BANDS }),
    );
  }),

  http.put('*/api/vitals/ranges', async ({ request }) => {
    const access = authorize(request, { permission: CONFIGURE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const body: unknown = await request.json();
    if (!isObject(body) || typeof body.version !== 'number' || !isObject(body.bands)) {
      return error(400, 'validation_failed', 'A version and the bands are needed');
    }
    const bands = {} as VitalRangeTable['bands'];
    for (const band of BANDS) {
      const set = body.bands[band];
      if (!isObject(set)) return error(400, 'validation_failed', `Band ${band} is missing`);
      bands[band] = {};
      for (const measure of RANGED) {
        const limits = set[measure];
        if (limits === undefined) continue;
        if (!isObject(limits)) return error(400, 'validation_failed', 'A range is an object');
        const { low, high } = limits;
        for (const limit of [low, high]) {
          if (limit !== undefined && (typeof limit !== 'number' || limit < 0 || limit > 999.9)) {
            return error(400, 'validation_failed', 'A limit is a number from 0 to 999.9');
          }
          if (typeof limit === 'number' && Math.round(limit * 10) / 10 !== limit) {
            return error(422, 'invalid_range', 'A limit has at most one decimal');
          }
        }
        if (typeof low === 'number' && typeof high === 'number' && low >= high) {
          return error(422, 'invalid_range', 'A low limit must be below its high limit');
        }
        // A measure with neither limit is not checked, and is not kept.
        if (low !== undefined || high !== undefined) {
          bands[band][measure] = {
            ...(typeof low === 'number' ? { low } : {}),
            ...(typeof high === 'number' ? { high } : {}),
          };
        }
      }
    }
    const current = ranges[tenantId] ?? { version: 0, bands: DEFAULT_BANDS };
    if (body.version !== current.version) {
      return error(409, 'conflict', 'The ranges were changed by someone else');
    }
    // Readings already recorded keep the marks they were given: flags are stored with them.
    ranges[tenantId] = { version: current.version + 1, bands };
    return HttpResponse.json<VitalRangeTable>(structuredClone(ranges[tenantId]));
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
    const items: Allergy[] = [];
    for (const raw of body.items as Record<string, unknown>[]) {
      if (raw.allergenId !== undefined && raw.drugId !== undefined) {
        return error(400, 'validation_failed', 'A catalog entry or a medicine, not both');
      }
      // One already on the list stays as recorded.
      const held = current.items.find(
        (each) =>
          (raw.allergenId !== undefined && each.allergenId === raw.allergenId) ||
          (raw.drugId !== undefined && each.drugId === raw.drugId),
      );
      const coded = held
        ? { ...held, severity: raw.severity as Allergy['severity'] }
        : codedAllergy(tenantId, raw);
      if (coded === 'unknown') return error(422, 'unknown_allergen', 'No such allergen');
      const plain: Allergy = {
        substance: raw.substance as string,
        severity: raw.severity as Allergy['severity'],
      };
      // The reaction is the request's, never the one an earlier version had.
      const { reaction: _kept, ...base } = coded ?? plain;
      items.push(
        structuredClone({
          ...base,
          ...(typeof raw.reaction === 'string' ? { reaction: raw.reaction } : {}),
        }),
      );
    }
    const stored: StoredAllergies = {
      tenantId,
      patientId,
      status: body.status as 'none' | 'listed',
      items,
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

/** A hospital's ranges as the mock holds them. */
export function mockRangeTable(tenantId: string): VitalRangeTable {
  return structuredClone(ranges[tenantId] ?? { version: 0, bands: DEFAULT_BANDS });
}

/** Changes a hospital's adult pulse range behind the screen, as another admin would. */
export function editMockAdultPulse(tenantId: string, range: { low?: number; high?: number }): void {
  const current = mockRangeTable(tenantId);
  ranges[tenantId] = {
    version: current.version + 1,
    bands: { ...current.bands, adult: { ...current.bands.adult, pulse: range } },
  };
}
