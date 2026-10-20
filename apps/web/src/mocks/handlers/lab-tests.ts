import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error, searchBody } from '../respond';
import { mockServiceNamed } from './services';
// The age rules are one file, shared with the form, so the two cannot disagree.
import {
  AGE_UNITS,
  ageBefore,
  ageWithinMax,
  bandForAge,
  bandsOverlap,
  type Age,
} from '@/features/lab-tests/age';

type LabTest = components['schemas']['LabTest'];
type LabTestPage = components['schemas']['LabTestPage'];
type LabRange = components['schemas']['LabRange'];
type LabRanges = components['schemas']['LabRanges'];
type Department = LabTest['department'];
type Sample = LabTest['sampleType'];

const FEATURE_FLAG = 'lab_tests';
const READ = 'labTest:read';
const MANAGE = 'labTest:manage';

const DEPARTMENTS: readonly Department[] = [
  'biochemistry',
  'haematology',
  'microbiology',
  'serology',
  'hormones',
  'pathology',
  'other',
];
const SAMPLES: readonly Sample[] = [
  'blood',
  'serum',
  'plasma',
  'urine',
  'stool',
  'swab',
  'sputum',
  'csf',
  'tissue',
  'other',
];
const KINDS: readonly LabTest['kind'][] = ['test', 'panel'];
const RESULT_TYPES: readonly LabTest['resultType'][] = ['numeric', 'text'];
const SEXES: readonly LabRange['sex'][] = ['any', 'male', 'female'];
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What is stored: the components by id, and the service by id. Names are read when shown. */
type Stored = Omit<LabTest, 'components' | 'serviceName'> & { componentIds: string[] };

/** Numeric tests: code, name, section, sample, container, hours, unit, low, high. Synthetic. */
const NUMERIC: [string, string, Department, Sample, string, number, string, number, number][] = [
  ['HB', 'Haemoglobin', 'haematology', 'blood', 'EDTA tube', 4, 'g/dL', 12, 16],
  ['WBC', 'Total white cell count', 'haematology', 'blood', 'EDTA tube', 4, '10^3/uL', 4, 11],
  ['PLT', 'Platelet count', 'haematology', 'blood', 'EDTA tube', 4, '10^3/uL', 150, 450],
  ['RBC', 'Red cell count', 'haematology', 'blood', 'EDTA tube', 4, '10^6/uL', 4, 6],
  ['HCT', 'Haematocrit', 'haematology', 'blood', 'EDTA tube', 4, '%', 36, 50],
  ['MCV', 'Mean cell volume', 'haematology', 'blood', 'EDTA tube', 4, 'fL', 80, 100],
  [
    'ESR',
    'Erythrocyte sedimentation rate',
    'haematology',
    'blood',
    'Citrate tube',
    6,
    'mm/h',
    0,
    20,
  ],
  ['GLU-F', 'Glucose, fasting', 'biochemistry', 'plasma', 'Fluoride tube', 4, 'mg/dL', 70, 100],
  ['GLU-R', 'Glucose, random', 'biochemistry', 'plasma', 'Fluoride tube', 4, 'mg/dL', 70, 140],
  ['HBA1C', 'Glycated haemoglobin', 'biochemistry', 'blood', 'EDTA tube', 24, '%', 4, 5.6],
  ['UREA', 'Urea', 'biochemistry', 'serum', 'Plain tube', 6, 'mg/dL', 15, 40],
  ['CREA', 'Creatinine', 'biochemistry', 'serum', 'Plain tube', 6, 'mg/dL', 0.6, 1.2],
  ['NA', 'Sodium', 'biochemistry', 'serum', 'Plain tube', 6, 'mmol/L', 135, 145],
  ['K', 'Potassium', 'biochemistry', 'serum', 'Plain tube', 6, 'mmol/L', 3.5, 5.1],
  ['CL', 'Chloride', 'biochemistry', 'serum', 'Plain tube', 6, 'mmol/L', 98, 107],
  ['UA', 'Uric acid', 'biochemistry', 'serum', 'Plain tube', 6, 'mg/dL', 3.5, 7.2],
  ['CA', 'Calcium', 'biochemistry', 'serum', 'Plain tube', 6, 'mg/dL', 8.6, 10.2],
  ['CHOL', 'Total cholesterol', 'biochemistry', 'serum', 'Plain tube', 8, 'mg/dL', 0, 200],
  ['HDL', 'HDL cholesterol', 'biochemistry', 'serum', 'Plain tube', 8, 'mg/dL', 40, 60],
  ['LDL', 'LDL cholesterol', 'biochemistry', 'serum', 'Plain tube', 8, 'mg/dL', 0, 100],
  ['TG', 'Triglycerides', 'biochemistry', 'serum', 'Plain tube', 8, 'mg/dL', 0, 150],
  ['TBIL', 'Bilirubin, total', 'biochemistry', 'serum', 'Plain tube', 8, 'mg/dL', 0.2, 1.2],
  ['DBIL', 'Bilirubin, direct', 'biochemistry', 'serum', 'Plain tube', 8, 'mg/dL', 0, 0.3],
  ['ALT', 'Alanine aminotransferase', 'biochemistry', 'serum', 'Plain tube', 8, 'U/L', 7, 56],
  ['AST', 'Aspartate aminotransferase', 'biochemistry', 'serum', 'Plain tube', 8, 'U/L', 10, 40],
  ['ALP', 'Alkaline phosphatase', 'biochemistry', 'serum', 'Plain tube', 8, 'U/L', 44, 147],
  ['TP', 'Total protein', 'biochemistry', 'serum', 'Plain tube', 8, 'g/dL', 6, 8.3],
  ['ALB', 'Albumin', 'biochemistry', 'serum', 'Plain tube', 8, 'g/dL', 3.5, 5.5],
  ['TSH', 'Thyroid stimulating hormone', 'hormones', 'serum', 'Gel tube', 24, 'mIU/L', 0.4, 4],
  ['T3', 'Triiodothyronine', 'hormones', 'serum', 'Gel tube', 24, 'ng/dL', 80, 200],
  ['T4', 'Thyroxine', 'hormones', 'serum', 'Gel tube', 24, 'ug/dL', 5, 12],
  ['U-PH', 'Urine pH', 'pathology', 'urine', 'Sterile cup', 4, '', 4.5, 8],
];
/** Tests whose result is text: code, name, section, sample, container, hours. */
const TEXTUAL: [string, string, Department, Sample, string, number][] = [
  ['HIV', 'HIV antibody', 'serology', 'serum', 'Plain tube', 24],
  ['HBSAG', 'Hepatitis B surface antigen', 'serology', 'serum', 'Plain tube', 24],
  ['WIDAL', 'Widal test', 'serology', 'serum', 'Plain tube', 24],
  ['DENG', 'Dengue NS1 antigen', 'serology', 'serum', 'Plain tube', 6],
  ['MAL', 'Malaria antigen', 'serology', 'blood', 'EDTA tube', 4],
  ['BGRP', 'Blood group and Rh type', 'haematology', 'blood', 'EDTA tube', 4],
  ['U-CS', 'Urine culture and sensitivity', 'microbiology', 'urine', 'Sterile cup', 72],
  ['B-CS', 'Blood culture and sensitivity', 'microbiology', 'blood', 'Culture bottle', 120],
  ['SPUT', 'Sputum for acid-fast bacilli', 'microbiology', 'sputum', 'Sterile cup', 48],
  ['STOOL', 'Stool routine', 'pathology', 'stool', 'Sterile cup', 6],
];
/** Panels: code, name, section, sample, container, hours, the service's name, the tests. */
const PANELS: [string, string, Department, Sample, string, number, string, string[]][] = [
  [
    'CBC',
    'Complete blood count',
    'haematology',
    'blood',
    'EDTA tube',
    4,
    'Complete blood count',
    ['HB', 'WBC', 'PLT', 'RBC', 'HCT', 'MCV'],
  ],
  [
    'LIPID',
    'Lipid profile',
    'biochemistry',
    'serum',
    'Plain tube',
    8,
    'Lipid profile',
    ['CHOL', 'HDL', 'LDL', 'TG'],
  ],
  [
    'LFT',
    'Liver function test',
    'biochemistry',
    'serum',
    'Plain tube',
    8,
    'Liver function test',
    ['TBIL', 'DBIL', 'ALT', 'AST', 'ALP', 'TP', 'ALB'],
  ],
  [
    'KFT',
    'Kidney function test',
    'biochemistry',
    'serum',
    'Plain tube',
    6,
    'Kidney function test',
    ['UREA', 'CREA', 'NA', 'K', 'CL', 'UA'],
  ],
  [
    'TFT',
    'Thyroid profile',
    'hormones',
    'serum',
    'Gel tube',
    24,
    'Thyroid profile',
    ['TSH', 'T3', 'T4'],
  ],
];

interface State {
  tests: Stored[];
  /** The reference ranges of a test and their version, by the test's id. */
  ranges: Map<string, { ranges: LabRange[]; version: number }>;
  created: number;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, { raw: string; id: string }>;
}

const BIRTH: Age = { value: 0, unit: 'days' };
const MONTH: Age = { value: 1, unit: 'months' };
const TWELVE: Age = { value: 12, unit: 'years' };

/** More than one page at the hospital, in every section, with panels and ranges. */
function seed(): State {
  const tests: Stored[] = [];
  const ranges: State['ranges'] = new Map();
  const add = (tenantId: string, prefix: string, test: Omit<Stored, 'id' | 'tenantId'>) => {
    const stored: Stored = { id: `${prefix}_${test.code.toLowerCase()}`, tenantId, ...test };
    tests.push(stored);
    return stored;
  };
  const base = { archived: false, version: 1, componentIds: [] as string[] };
  for (const [code, name, department, sampleType, container, hours, unit, low, high] of NUMERIC) {
    const test = add(TENANT_IDS.hospital, 'lab_h', {
      ...base,
      code,
      name,
      department,
      kind: 'test',
      resultType: 'numeric',
      ...(unit ? { unit } : {}),
      sampleType,
      container,
      turnaroundHours: hours,
      ...(code === 'GLU-F'
        ? { serviceId: mockServiceNamed(TENANT_IDS.hospital, 'Blood glucose fasting')?.id }
        : {}),
    });
    ranges.set(test.id, { ranges: [{ sex: 'any', ageFrom: BIRTH, low, high }], version: 1 });
  }
  // Haemoglobin is read by age and sex: the newborn, the child, and men and women apart.
  ranges.set('lab_h_hb', {
    version: 1,
    ranges: [
      { sex: 'any', ageFrom: BIRTH, ageUntil: MONTH, low: 14, high: 22, criticalLow: 9 },
      { sex: 'any', ageFrom: MONTH, ageUntil: TWELVE, low: 11, high: 14, criticalLow: 7 },
      { sex: 'male', ageFrom: TWELVE, low: 13, high: 17, criticalLow: 7, criticalHigh: 20 },
      {
        sex: 'female',
        ageFrom: TWELVE,
        low: 12,
        high: 15,
        criticalLow: 7,
        criticalHigh: 20,
      },
    ],
  });
  // A test set up without ranges yet.
  ranges.set('lab_h_esr', { ranges: [], version: 1 });
  for (const [code, name, department, sampleType, container, hours] of TEXTUAL) {
    add(TENANT_IDS.hospital, 'lab_h', {
      ...base,
      code,
      name,
      department,
      kind: 'test',
      resultType: 'text',
      sampleType,
      container,
      turnaroundHours: hours,
    });
  }
  for (const [code, name, department, sampleType, container, hours, service, parts] of PANELS) {
    add(TENANT_IDS.hospital, 'lab_h', {
      ...base,
      code,
      name,
      department,
      kind: 'panel',
      resultType: 'text',
      sampleType,
      container,
      turnaroundHours: hours,
      serviceId: mockServiceNamed(TENANT_IDS.hospital, service)?.id,
      componentIds: parts.map((part) => `lab_h_${part.toLowerCase()}`),
    });
  }
  add(TENANT_IDS.hospital, 'lab_h', {
    ...base,
    code: 'BT-OLD',
    name: 'Bleeding time, old method',
    department: 'haematology',
    kind: 'test',
    resultType: 'numeric',
    unit: 'min',
    sampleType: 'blood',
    turnaroundHours: 2,
    archived: true,
    version: 2,
  });
  ranges.set('lab_h_bt-old', { ranges: [], version: 1 });
  // The clinic has its own small catalog, with a code the hospital uses too.
  for (const [code, name] of [
    ['HB', 'Haemoglobin (clinic)'],
    ['GLU-R', 'Glucose, random (clinic)'],
  ] as const) {
    const test = add(TENANT_IDS.clinic, 'lab_c', {
      ...base,
      code,
      name,
      department: code === 'HB' ? 'haematology' : 'biochemistry',
      kind: 'test',
      resultType: 'numeric',
      sampleType: 'blood',
      turnaroundHours: 24,
    });
    ranges.set(test.id, { ranges: [], version: 1 });
  }
  return { tests, ranges, created: 0, replies: new Map() };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** What another member of staff does meanwhile: changes a test behind the open screen. */
export function editMockLabTest(id: string, changes: Partial<Stored>): void {
  const test = state.tests.find((candidate) => candidate.id === id);
  if (!test) throw new Error(`Unknown mock lab test: ${id}`);
  Object.assign(test, changes, { version: test.version + 1 });
}

/** The same for its reference ranges. */
export function editMockLabRanges(id: string, ranges: LabRange[]): void {
  const held = state.ranges.get(id);
  if (!held) throw new Error(`Unknown mock lab test: ${id}`);
  state.ranges.set(id, { ranges, version: held.version + 1 });
}

/** A test or panel of the hospital, as ordering finds it (the API's `orderableLabTest`). */
export function mockOrderableLabTest(tenantId: string, id: string) {
  const test = find(tenantId, id);
  return test && !test.archived ? { id: test.id, code: test.code, name: test.name } : undefined;
}

const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const notFound = () => error(404, 'lab_test_not_found', 'No such test');

/** A test of another hospital does not exist as far as this session is concerned. */
const find = (tenantId: string, id: unknown) =>
  state.tests.find((candidate) => candidate.id === id && candidate.tenantId === tenantId);

/** The test as the API shows it: with the names of its service and of its components. */
function view(test: Stored): LabTest {
  const { componentIds, ...rest } = test;
  const service = test.serviceId
    ? mockServiceNamed(test.tenantId, undefined, test.serviceId)
    : null;
  return {
    ...rest,
    ...(service ? { serviceName: service.name } : {}),
    components: componentIds.flatMap((id) => {
      const part = find(test.tenantId, id);
      return part ? [{ id: part.id, code: part.code, name: part.name }] : [];
    }),
  };
}

const collator = new Intl.Collator('en', { sensitivity: 'base' });
const byName = (a: Stored, b: Stored) =>
  collator.compare(a.name, b.name) || a.id.localeCompare(b.id);

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

const oneOf = <Value extends string>(values: readonly Value[], value: unknown) =>
  values.find((candidate) => candidate === value);

/**
 * The fields of a body laid over a test, checked as the API would. Empty text removes an
 * optional field. Everything named is looked up at the session's hospital, never by id alone.
 * Null when not acceptable.
 */
function applied(base: Stored, body: Record<string, unknown>): Stored | null {
  const next: Stored = { ...base };
  const text = (key: 'unit' | 'container', max: number): boolean => {
    const value = body[key];
    if (value === undefined) return true;
    if (typeof value !== 'string' || value.trim().length > max) return false;
    if (value.trim()) next[key] = value.trim();
    else delete next[key];
    return true;
  };
  if (body.name !== undefined) {
    const name = body.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) return null;
    next.name = name.trim();
  }
  if (body.department !== undefined) {
    const department = oneOf(DEPARTMENTS, body.department);
    if (!department) return null;
    next.department = department;
  }
  if (body.resultType !== undefined) {
    const resultType = oneOf(RESULT_TYPES, body.resultType);
    if (!resultType) return null;
    next.resultType = resultType;
  }
  if (body.sampleType !== undefined) {
    const sampleType = oneOf(SAMPLES, body.sampleType);
    if (!sampleType) return null;
    next.sampleType = sampleType;
  }
  if (!text('unit', 30) || !text('container', 50)) return null;
  if (body.turnaroundHours !== undefined) {
    const hours = body.turnaroundHours;
    if (!Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > 720) return null;
    next.turnaroundHours = hours as number;
  }
  if (body.serviceId !== undefined) {
    if (typeof body.serviceId !== 'string') return null;
    if (body.serviceId === '') delete next.serviceId;
    else {
      // A laboratory service of this hospital, or it is refused.
      const service = mockServiceNamed(base.tenantId, undefined, body.serviceId);
      if (!service || service.category !== 'lab') return null;
      next.serviceId = service.id;
    }
  }
  if (body.componentIds !== undefined) {
    const ids = body.componentIds;
    if (!Array.isArray(ids) || ids.length > 60 || new Set(ids).size !== ids.length) return null;
    // Each a single test of this hospital that is in use.
    const parts = ids.map((id) => find(base.tenantId, id));
    if (parts.some((part) => !part || part.kind !== 'test' || part.archived)) return null;
    next.componentIds = ids as string[];
  }
  // A panel is made of tests; a single test has none.
  if (next.kind === 'panel' ? next.componentIds.length === 0 : next.componentIds.length > 0) {
    return null;
  }
  return next;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
/** An age as the contract has it: a whole value with a unit, at most 150 years. */
function readAge(value: unknown): Age | null {
  if (typeof value !== 'object' || value === null) return null;
  const { value: amount, unit } = value as Record<string, unknown>;
  const known = oneOf(AGE_UNITS, unit);
  if (!known || !Number.isInteger(amount)) return null;
  const age: Age = { value: amount as number, unit: known };
  return ageWithinMax(age) ? age : null;
}

/** The ranges of a body, checked as the API would. Null when not acceptable. */
function readRanges(value: unknown): LabRange[] | null {
  if (!Array.isArray(value) || value.length > 60) return null;
  const ranges: LabRange[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const sex = oneOf(SEXES, raw.sex);
    const { low, high, criticalLow, criticalHigh, note } = raw;
    const ageFrom = readAge(raw.ageFrom);
    const ageUntil = raw.ageUntil === undefined ? undefined : readAge(raw.ageUntil);
    if (!sex || !ageFrom || ageUntil === null) return null;
    // Later than where it starts, for every date of birth.
    if (ageUntil && !ageBefore(ageFrom, ageUntil)) return null;
    for (const limit of [low, high, criticalLow, criticalHigh]) {
      if (limit !== undefined && !isNumber(limit)) return null;
    }
    const numbers = { low, high, criticalLow, criticalHigh } as Record<string, number | undefined>;
    if (numbers.low === undefined && numbers.high === undefined) return null;
    if (numbers.low !== undefined && numbers.high !== undefined && numbers.low >= numbers.high) {
      return null;
    }
    const floor = numbers.low ?? numbers.high;
    const ceiling = numbers.high ?? numbers.low;
    if (numbers.criticalLow !== undefined && floor !== undefined && numbers.criticalLow > floor) {
      return null;
    }
    if (
      numbers.criticalHigh !== undefined &&
      ceiling !== undefined &&
      numbers.criticalHigh < ceiling
    ) {
      return null;
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 150)) return null;
    const range: LabRange = {
      sex,
      ageFrom,
      ...(ageUntil ? { ageUntil } : {}),
      ...Object.fromEntries(Object.entries(numbers).filter(([, limit]) => limit !== undefined)),
      ...(note ? { note } : {}),
    };
    // Two rows for the same people never cover the same age.
    const clash = ranges.some((other) => bandsOverlap(other, range));
    if (clash) return null;
    ranges.push(range);
  }
  return ranges;
}

const takesRanges = (test: Stored) => test.kind === 'test' && test.resultType === 'numeric';

export const labTestsHandlers = [
  // A search reads data only; it is a POST so that what was typed is never in an address.
  http.post('*/api/lab-tests/search', async ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = await searchBody(request);
    const words = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const archived = params.get('archived') === 'true';
    const only = (key: string, value: string) => !params.get(key) || params.get(key) === value;
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = state.tests
      .filter((test) => test.tenantId === access.tenantId && test.archived === archived)
      .filter((test) => only('department', test.department) && only('kind', test.kind))
      .filter((test) => {
        const haystack = `${test.code} ${test.name}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort(byName);
    const limit = Math.min(Math.max(Number(params.get('limit')) || 25, 1), 100);
    const cursor = params.get('cursor');
    const start = cursor ? visible.findIndex((test) => test.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[start + limit];
    return HttpResponse.json<LabTestPage>({
      items: visible.slice(start, start + limit).map(view),
      nextCursor: next?.id ?? null,
      // With the first page only, as the contract says.
      ...(cursor ? {} : { total: visible.length }),
    });
  }),

  http.post('*/api/lab-tests', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const raw = await request.clone().text();
    // The same key with the same request is answered as before, and nothing is added again.
    const key = request.headers.get('idempotency-key');
    const earlier = key ? state.replies.get(`${access.tenantId}:${key}`) : undefined;
    if (earlier) {
      const test = find(access.tenantId, earlier.id);
      return earlier.raw === raw && test
        ? HttpResponse.json<LabTest>(view(test), {
            status: 201,
            headers: { 'Idempotent-Replayed': 'true' },
          })
        : error(422, 'idempotency_key_reuse', 'That key was used for another request');
    }
    const body = await readBody(request);
    const kind = oneOf(KINDS, body?.kind);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!body || !kind || !code || code.length > 30 || !CODE.test(code)) return invalid();
    if (!body.name || !body.department || !body.sampleType || !body.turnaroundHours) {
      return invalid();
    }
    const test = applied(
      {
        id: `lab_new_${state.created + 1}`,
        tenantId: access.tenantId,
        code,
        name: '',
        department: 'other',
        kind,
        resultType: 'text',
        sampleType: 'other',
        turnaroundHours: 1,
        componentIds: [],
        archived: false,
        version: 1,
      },
      // A panel has no result of its own, whatever was sent.
      kind === 'panel' ? { ...body, resultType: 'text', unit: '' } : body,
    );
    if (!test) return invalid();
    // The code is taken by any test of the hospital, archived or not, whatever the capitals.
    const taken = state.tests.some(
      (other) =>
        other.tenantId === access.tenantId && other.code.toLowerCase() === code.toLowerCase(),
    );
    if (taken) return error(409, 'lab_test_code_taken', 'The hospital has a test with that code');
    state.created += 1;
    state.tests.push(test);
    state.ranges.set(test.id, { ranges: [], version: 1 });
    if (key) state.replies.set(`${access.tenantId}:${key}`, { raw, id: test.id });
    return HttpResponse.json<LabTest>(view(test), { status: 201 });
  }),

  http.get('*/api/lab-tests/:labTestId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const test = find(access.tenantId, params.labTestId);
    return test ? HttpResponse.json<LabTest>(view(test)) : notFound();
  }),

  http.patch('*/api/lab-tests/:labTestId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (!body || typeof body.expectedVersion !== 'number') return invalid();
    // Neither the code nor the kind is ever changed.
    if (body.code !== undefined || body.kind !== undefined) return invalid();
    const test = find(access.tenantId, params.labTestId);
    if (!test) return notFound();
    if (test.version !== body.expectedVersion) return error(409, 'conflict', 'It has changed');
    // A panel has no result of its own, whatever was sent.
    const next = applied(
      test,
      test.kind === 'panel' ? { ...body, resultType: 'text', unit: '' } : body,
    );
    if (!next) return invalid();
    // The ranges are numbers in the test's unit: they stand only while it is numeric and in it.
    if (
      (!takesRanges(next) || next.unit !== test.unit) &&
      (state.ranges.get(test.id)?.ranges.length ?? 0) > 0
    ) {
      return error(409, 'lab_test_has_ranges', 'Remove the reference ranges first');
    }
    // Sending what the test already has changes nothing.
    if (JSON.stringify(next) !== JSON.stringify(test)) next.version = test.version + 1;
    state.tests[state.tests.indexOf(test)] = next;
    return HttpResponse.json<LabTest>(view(next));
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/lab-tests/:labTestId/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const test = find(access.tenantId, params.labTestId);
      if (!test) return notFound();
      const archived = action === 'archive';
      // Doing it twice is harmless, so a retried request cannot fail.
      if (test.archived === archived) return HttpResponse.json<LabTest>(view(test));
      const inPanel = state.tests.some(
        (panel) =>
          panel.tenantId === access.tenantId &&
          !panel.archived &&
          panel.componentIds.includes(test.id),
      );
      if (archived && inPanel) {
        return error(409, 'lab_test_in_panel', 'The test is part of a panel in use');
      }
      // A panel in use is made of tests in use.
      const partArchived = test.componentIds.some((id) => find(access.tenantId, id)?.archived);
      if (!archived && partArchived) {
        return error(409, 'lab_test_component_archived', 'A test of the panel is archived');
      }
      test.archived = archived;
      test.version += 1;
      return HttpResponse.json<LabTest>(view(test));
    }),
  ),

  // Before `/ranges`, which is a prefix of it.
  http.get('*/api/lab-tests/:labTestId/ranges/resolve', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    // Whole digits only: an empty value is not zero.
    const digits = query.get('ageValue') ?? '';
    const age = readAge({
      value: /^\d{1,5}$/.test(digits) ? Number(digits) : Number.NaN,
      unit: query.get('ageUnit'),
    });
    const sex = oneOf(['male', 'female', 'other'] as const, query.get('sex'));
    if (!age || !sex) return invalid();
    const test = find(access.tenantId, params.labTestId);
    if (!test) return notFound();
    const ranges = state.ranges.get(test.id)?.ranges ?? [];
    // The row for the patient's sex comes before the row for anyone.
    const range = bandForAge(ranges, sex, age);
    return HttpResponse.json(range ? { range } : {});
  }),

  http.get('*/api/lab-tests/:labTestId/ranges', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const test = find(access.tenantId, params.labTestId);
    if (!test) return notFound();
    const held = state.ranges.get(test.id) ?? { ranges: [], version: 1 };
    return HttpResponse.json<LabRanges>({ labTestId: test.id, ...held });
  }),

  http.put('*/api/lab-tests/:labTestId/ranges', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (!body || typeof body.expectedVersion !== 'number') return invalid();
    const test = find(access.tenantId, params.labTestId);
    if (!test) return notFound();
    if (!takesRanges(test)) {
      return error(409, 'lab_test_has_no_ranges', 'Only a numeric test has reference ranges');
    }
    const held = state.ranges.get(test.id) ?? { ranges: [], version: 1 };
    if (held.version !== body.expectedVersion) return error(409, 'conflict', 'They have changed');
    const ranges = readRanges(body.ranges);
    if (!ranges) return invalid();
    const saved = { ranges, version: held.version + 1 };
    state.ranges.set(test.id, saved);
    return HttpResponse.json<LabRanges>({ labTestId: test.id, ...saved });
  }),
];
