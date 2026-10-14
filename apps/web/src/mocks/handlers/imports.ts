import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentPolicy, currentSession, onMockReset } from '../db';
import { authorize, error } from '../respond';

type Batch = components['schemas']['ImportBatch'];
type Kind = components['schemas']['ImportKind'];
type Column = components['schemas']['ImportColumn'];
type Problem = components['schemas']['ImportProblem'];

const FEATURE_FLAG = 'imports';
const READ = 'import:read';
const RUN = 'import:run';
const BATCH_ROWS_MAX = 20_000;
const CHUNK_ROWS_MAX = 1_000;
/** Rows a job gets through between two reads of its batch, so a screen sees it move. */
const STEP = 4_000;

const enumOf = (field: string, values: string[], required = true): Column => ({
  field,
  required,
  type: 'enum',
  values,
});
const text = (field: string, required = false): Column => ({ field, required, type: 'text' });
const TAX = ['exempt', 'reduced', 'standard', 'higher'];

/** The kinds of the real API, with the module and the permissions each needs. */
const KINDS: (Kind & { feature: string; permissions: string[]; key: string[] })[] = [
  {
    kind: 'services',
    feature: 'services',
    permissions: ['service:manage'],
    key: ['code'],
    columns: [
      text('code', true),
      text('name', true),
      enumOf('category', ['consultation', 'procedure', 'bed', 'lab', 'imaging', 'package']),
      enumOf('taxClass', TAX),
      text('description'),
      { field: 'priceMinor', required: false, type: 'amount' },
    ],
  },
  {
    kind: 'drugs',
    feature: 'drugs',
    permissions: ['drug:manage'],
    key: ['genericName', 'brandName', 'form', 'strength'],
    columns: [
      enumOf('type', ['medicine', 'consumable']),
      text('genericName', true),
      text('brandName'),
      enumOf('form', [
        'tablet',
        'capsule',
        'syrup',
        'suspension',
        'injection',
        'infusion',
        'cream',
        'ointment',
        'drops',
        'inhaler',
        'powder',
        'device',
        'other',
      ]),
      text('strength'),
      text('unit'),
      enumOf('schedule', ['none', 'h', 'h1', 'x', 'g', 'narcotic']),
      { field: 'controlled', required: false, type: 'boolean' },
      enumOf('taxClass', TAX),
      { field: 'reorderLevel', required: false, type: 'integer' },
    ],
  },
  {
    kind: 'lab_tests',
    feature: 'lab_tests',
    permissions: ['labTest:manage'],
    key: ['code'],
    columns: [
      text('code', true),
      text('name', true),
      enumOf('department', [
        'biochemistry',
        'haematology',
        'microbiology',
        'serology',
        'hormones',
        'pathology',
        'other',
      ]),
      enumOf('resultType', ['numeric', 'text'], false),
      text('unit'),
      enumOf('sampleType', [
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
      ]),
      text('container'),
      { field: 'turnaroundHours', required: true, type: 'integer' },
      text('serviceCode'),
    ],
  },
  {
    kind: 'patients',
    feature: 'patients',
    permissions: ['patient:create', 'patient:import'],
    key: ['firstName', 'lastName', 'dob'],
    columns: [
      text('firstName', true),
      text('lastName', true),
      { field: 'dob', required: true, type: 'date' },
      enumOf('gender', ['male', 'female', 'other']),
      text('phone', true),
      text('email'),
      text('address'),
    ],
  },
];

interface Stored {
  batch: Batch;
  rows: Map<number, Record<string, string>>;
  problems: Problem[];
}

let batches = new Map<string, Stored>();
let created = 0;
onMockReset(() => {
  batches = new Map();
  created = 0;
});

/** Whether the signed-in person may load this kind at the active hospital. */
function mayLoad(kind: (typeof KINDS)[number]): boolean {
  const policy = currentPolicy();
  if (!policy || policy.features[kind.feature] !== true) return false;
  return kind.permissions.every((permission) =>
    policy.permissions.some((grant) => grant.permission === permission),
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^(\d+|\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})*,\d{3})(\.\d{1,2})?$/;
const YES_NO = new Set(['yes', 'no', 'y', 'n', 'true', 'false', '1', '0']);

/** The problems of one row, as the API's conversion finds them. */
function rowProblems(columns: Column[], values: Record<string, string>): Omit<Problem, 'line'>[] {
  const problems: Omit<Problem, 'line'>[] = [];
  for (const column of columns) {
    const value = (values[column.field] ?? '').trim();
    if (value === '') {
      if (column.required) problems.push({ field: column.field, code: 'required' });
      continue;
    }
    const code =
      column.type === 'integer' && !/^\d{1,15}$/.test(value)
        ? 'not_a_whole_number'
        : column.type === 'boolean' && !YES_NO.has(value.toLowerCase())
          ? 'not_yes_or_no'
          : column.type === 'enum' && !(column.values ?? []).includes(value.toLowerCase())
            ? 'not_allowed'
            : column.type === 'date' && !DATE.test(value)
              ? 'not_a_date'
              : column.type === 'amount' && !AMOUNT.test(value)
                ? 'not_an_amount'
                : null;
    if (code) problems.push({ field: column.field, code });
  }
  return problems;
}

function checkAll(stored: Stored): Problem[] {
  const kind = KINDS.find((item) => item.kind === stored.batch.kind);
  if (!kind) return [];
  const problems: Problem[] = [];
  const keys = new Set<string>();
  for (const line of [...stored.rows.keys()].sort((a, b) => a - b)) {
    const values = stored.rows.get(line) ?? {};
    const found = rowProblems(kind.columns, values);
    if (found.length > 0) {
      problems.push(...found.map((problem) => ({ ...problem, line })));
      continue;
    }
    const key = kind.key.map((field) => (values[field] ?? '').trim().toLowerCase()).join('|');
    if (keys.has(key)) problems.push({ line, code: 'duplicate_in_file' });
    keys.add(key);
  }
  return problems;
}

/** Moves a batch's job on by one step, as if it had been working since the last read. */
function advance(stored: Stored): void {
  const { batch } = stored;
  const now = new Date().toISOString();
  if (batch.status === 'queued') {
    batch.status = 'running';
    batch.doneCount = 0;
    return;
  }
  if (batch.status !== 'checking' && batch.status !== 'running') return;
  batch.doneCount = Math.min(batch.doneCount + STEP, batch.rowCount);
  if (batch.doneCount < batch.rowCount) return;
  if (batch.status === 'checking') {
    stored.problems = checkAll(stored);
    batch.problemCount = stored.problems.length;
    batch.status = 'checked';
    batch.checkedAt = now;
  } else {
    // The mock writes nothing into the other features' lists: it shows how a batch moves.
    batch.status = 'committed';
    batch.finishedAt = now;
    stored.rows.clear();
  }
}

/** The batch of the active hospital, or the one answer for any other. */
function find(id: string, tenantId: string): Stored | Response {
  const stored = batches.get(id);
  return stored && stored.batch.tenantId === tenantId
    ? stored
    : error(404, 'import_not_found', 'No such batch');
}

const kindOf = (stored: Stored) => KINDS.find((item) => item.kind === stored.batch.kind);

/** The batch, if the person may act on its kind; else the answer to give. */
function actionable(id: string, tenantId: string): Stored | Response {
  const stored = find(id, tenantId);
  if (stored instanceof Response) return stored;
  const kind = kindOf(stored);
  if (!kind || !mayLoad(kind)) {
    return error(403, 'permission_denied', 'Loading this kind needs its own permission');
  }
  return stored;
}

export const importsHandlers = [
  http.get('*/api/imports/kinds', ({ request }) => {
    const access = authorize(request, { permission: RUN, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    return HttpResponse.json({
      items: KINDS.filter(mayLoad).map(({ kind, columns }) => ({ kind, columns })),
    });
  }),

  http.get('*/api/imports', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const all = [...batches.values()]
      .map((stored) => stored.batch)
      .filter((batch) => batch.tenantId === access.tenantId)
      .reverse();
    const items = all.slice(start, start + limit);
    return HttpResponse.json({
      items,
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    });
  }),

  http.post('*/api/imports', async ({ request }) => {
    const access = authorize(request, { permission: RUN, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as { kind?: unknown } | null;
    const kind = KINDS.find((item) => item.kind === body?.kind);
    if (!kind) return error(400, 'validation_failed', 'No such kind of record');
    if (!mayLoad(kind)) {
      return error(403, 'permission_denied', 'Loading this kind needs its own permission');
    }
    const user = currentSession()?.user;
    created += 1;
    const batch: Batch = {
      id: `imp_${String(created).padStart(4, '0')}`,
      tenantId: access.tenantId,
      kind: kind.kind,
      status: 'staging',
      rowCount: 0,
      doneCount: 0,
      problemCount: 0,
      createdBy: { id: user?.id ?? '', name: user?.name ?? '' },
      createdAt: new Date().toISOString(),
    };
    batches.set(batch.id, { batch, rows: new Map(), problems: [] });
    return HttpResponse.json(batch, { status: 201 });
  }),

  http.get('*/api/imports/:batchId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const stored = find(String(params.batchId), access.tenantId);
    if (stored instanceof Response) return stored;
    advance(stored);
    return HttpResponse.json(stored.batch);
  }),

  http.post('*/api/imports/:batchId/rows', async ({ request, params }) => {
    const access = authorize(request, { permission: RUN, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const stored = actionable(String(params.batchId), access.tenantId);
    if (stored instanceof Response) return stored;
    if (stored.batch.status !== 'staging') {
      return error(409, 'import_not_staging', 'Rows are added only before the check');
    }
    const body = (await request.json().catch(() => null)) as {
      fields?: string[];
      rows?: { line: number; values: string[] }[];
    } | null;
    const fields = body?.fields ?? [];
    const rows = body?.rows ?? [];
    const known = new Set(kindOf(stored)?.columns.map((column) => column.field));
    if (
      rows.length === 0 ||
      rows.length > CHUNK_ROWS_MAX ||
      fields.some((field) => !known.has(field)) ||
      rows.some((row) => row.values.length !== fields.length)
    ) {
      return error(400, 'validation_failed', 'Rows do not match the fields');
    }
    for (const row of rows) {
      if (stored.rows.has(row.line)) continue;
      stored.rows.set(
        row.line,
        Object.fromEntries(fields.map((field, index) => [field, row.values[index] ?? ''])),
      );
    }
    if (stored.rows.size > BATCH_ROWS_MAX) {
      return error(409, 'import_too_many_rows', 'A batch holds at most 20000 rows');
    }
    stored.batch.rowCount = stored.rows.size;
    return HttpResponse.json(stored.batch);
  }),

  http.post('*/api/imports/:batchId/:action', ({ request, params }) => {
    const access = authorize(request, { permission: RUN, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const stored = actionable(String(params.batchId), access.tenantId);
    if (stored instanceof Response) return stored;
    const { batch } = stored;
    switch (params.action) {
      case 'check':
        if (batch.status !== 'staging') {
          return error(409, 'import_not_staging', 'Only a staged batch is checked');
        }
        if (batch.rowCount === 0) return error(409, 'import_empty', 'The batch has no rows');
        batch.status = 'checking';
        batch.doneCount = 0;
        return HttpResponse.json(batch, { status: 202 });
      case 'commit': {
        if (batch.status !== 'checked' || batch.problemCount > 0) {
          return error(409, 'import_not_ready', 'Only a checked batch with no problems is written');
        }
        const writing = [...batches.values()].some(
          (other) =>
            other.batch.tenantId === batch.tenantId &&
            (other.batch.status === 'queued' || other.batch.status === 'running'),
        );
        if (writing) return error(409, 'import_running', 'Another batch is being written');
        batch.status = 'queued';
        return HttpResponse.json(batch, { status: 202 });
      }
      case 'cancel':
        if (batch.status === 'staging' || batch.status === 'checked') {
          batch.status = 'cancelled';
          batch.finishedAt = new Date().toISOString();
          stored.rows.clear();
        } else if (batch.status !== 'cancelled') {
          return error(409, 'import_busy', 'This batch is being checked or written, or is done');
        }
        return HttpResponse.json(batch);
      default:
        return error(404, 'not_found', 'No such action');
    }
  }),

  http.get('*/api/imports/:batchId/problems', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const stored = find(String(params.batchId), access.tenantId);
    if (stored instanceof Response) return stored;
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const cursor = url.searchParams.get('cursor');
    const start = cursor === null ? 0 : Number(cursor);
    const items = stored.problems.slice(start, start + limit);
    return HttpResponse.json({
      items,
      nextCursor: start + limit < stored.problems.length ? String(start + limit) : null,
      ...(cursor === null ? { total: stored.problems.length } : {}),
    });
  }),
];
