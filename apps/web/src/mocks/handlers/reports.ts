import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS, USER_IDS } from '../db';
import { authorize, error } from '../respond';

type Kind = components['schemas']['ReportResult']['kind'];
type Result = components['schemas']['ReportResult'];
type Run = components['schemas']['ReportRun'];
type Limits = components['schemas']['ReportLimits'];

const FEATURE_FLAG = 'reports';
const KINDS: readonly Kind[] = [
  'opd_census',
  'revenue',
  'doctor_activity',
  'lab_turnaround',
  'pharmacy_sales',
  'stock',
];
const SPOT_MAX_DAYS = 31;
const STORED_MAX_DAYS = 366;
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-05T09:00:00Z');

interface Stored extends Run {
  tenantId: string;
  /** How many times the run was read by id: a job takes a read or two to finish. */
  reads: number;
  /** Set for a run that will end failed, with this code. */
  willFail?: string;
}

const seed = (): Stored[] => [
  {
    id: 'rep_h_2',
    tenantId: TENANT_IDS.hospital,
    kind: 'revenue',
    from: '2026-10-01',
    to: '2026-10-31',
    status: 'succeeded',
    requestedBy: { id: USER_IDS.admin, name: 'Sample Admin' },
    requestedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    finishedAt: new Date(NOW - 2 * DAY_MS + 30_000).toISOString(),
    expiresAt: new Date(NOW + 28 * DAY_MS).toISOString(),
    rowCount: 31,
    reads: 9,
  },
  {
    id: 'rep_h_1',
    tenantId: TENANT_IDS.hospital,
    kind: 'lab_turnaround',
    from: '2026-01-01',
    to: '2026-12-31',
    status: 'failed',
    failure: 'too_large',
    requestedBy: { id: USER_IDS.admin, name: 'Sample Admin' },
    requestedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
    finishedAt: new Date(NOW - 3 * DAY_MS + 20_000).toISOString(),
    expiresAt: new Date(NOW + 27 * DAY_MS).toISOString(),
    reads: 9,
  },
  {
    id: 'rep_c_1',
    tenantId: TENANT_IDS.clinic,
    kind: 'stock',
    from: null,
    to: null,
    status: 'succeeded',
    requestedBy: { id: USER_IDS.admin, name: 'Sample Admin' },
    requestedAt: new Date(NOW - DAY_MS).toISOString(),
    finishedAt: new Date(NOW - DAY_MS + 5_000).toISOString(),
    expiresAt: new Date(NOW + 29 * DAY_MS).toISOString(),
    rowCount: 2,
    reads: 9,
  },
];

let runs = seed();
let keys = new Map<string, string>();
let nextId = 3;
/** The failure the next requested run will end with, and whether the quota is used up. */
let failNext: string | null = null;
let quotaUsed = false;
let busy = false;
onMockReset(() => {
  runs = seed();
  keys = new Map();
  nextId = 3;
  failNext = null;
  quotaUsed = false;
  busy = false;
});

/** For tests: the next stored report ends failed with this code. */
export const setMockReportFailure = (code: string | null) => {
  failNext = code;
};
/** For tests: the hospital has used up its stored reports. */
export const setMockReportQuota = (used: boolean) => {
  quotaUsed = used;
};
/** For tests: a report is already being worked out for the hospital. */
export const setMockReportBusy = (value: boolean) => {
  busy = value;
};

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS) + 1;

function result(kind: Kind, from: string | null, to: string | null): Result {
  const base = { kind, from, to, currency: 'INR', generatedAt: new Date(NOW).toISOString() };
  switch (kind) {
    case 'opd_census':
      return {
        ...base,
        columns: [
          { key: 'day', type: 'date' },
          { key: 'department', type: 'text' },
          { key: 'opened', type: 'integer' },
          { key: 'closed', type: 'integer' },
          { key: 'cancelled', type: 'integer' },
        ],
        rows: [
          [from ?? '2026-11-01', 'General Medicine', 42, 40, 2],
          [from ?? '2026-11-01', 'Paediatrics', 18, 18, 0],
          [to ?? '2026-11-02', 'General Medicine', 35, 33, 1],
        ],
        totals: [null, null, 95, 91, 3],
      };
    case 'revenue':
      return {
        ...base,
        columns: [
          { key: 'day', type: 'date' },
          { key: 'invoicedMinor', type: 'money' },
          { key: 'creditedMinor', type: 'money' },
          { key: 'collectedMinor', type: 'money' },
          { key: 'refundedMinor', type: 'money' },
          { key: 'netCollectedMinor', type: 'money' },
        ],
        rows: [
          [from ?? '2026-11-01', 1250000, 0, 1000000, 0, 1000000],
          [to ?? '2026-11-02', 480050, 50000, 480050, 10000, 470050],
        ],
        totals: [null, 1730050, 50000, 1480050, 10000, 1470050],
      };
    case 'doctor_activity':
      return {
        ...base,
        columns: [
          { key: 'doctor', type: 'text' },
          { key: 'department', type: 'text' },
          { key: 'opened', type: 'integer' },
          { key: 'closed', type: 'integer' },
          { key: 'cancelled', type: 'integer' },
          { key: 'appointmentsCompleted', type: 'integer' },
          { key: 'noShows', type: 'integer' },
        ],
        rows: [
          ['Dr Asha Rao', 'General Medicine', 52, 50, 1, 40, 4],
          ['Dr Vikram Shah', 'Paediatrics', 18, 18, 0, 15, 1],
        ],
        totals: [null, null, 70, 68, 1, 55, 5],
      };
    case 'pharmacy_sales':
      return {
        ...base,
        columns: [
          { key: 'day', type: 'date' },
          { key: 'sales', type: 'integer' },
          { key: 'soldMinor', type: 'money' },
          { key: 'returnedMinor', type: 'money' },
          { key: 'netSoldMinor', type: 'money' },
          { key: 'dispenses', type: 'integer' },
          { key: 'unitsDispensed', type: 'integer' },
        ],
        rows: [
          [from ?? '2026-11-01', 24, 185000, 5000, 180000, 60, 420],
          [to ?? '2026-11-02', 19, 96000, 0, 96000, 41, 260],
        ],
        totals: [null, 43, 281000, 5000, 276000, 101, 680],
      };
    case 'lab_turnaround':
      return {
        ...base,
        columns: [
          { key: 'testCode', type: 'text' },
          { key: 'testName', type: 'text' },
          { key: 'results', type: 'integer' },
          { key: 'avgMinutes', type: 'minutes' },
          { key: 'p90Minutes', type: 'minutes' },
          { key: 'maxMinutes', type: 'minutes' },
        ],
        rows: [
          ['CBC', 'Complete blood count', 120, 48, 95, 180],
          ['GLU', 'Glucose', 80, 22, 40, 75],
        ],
        totals: [null, null, 200, null, null, null],
      };
    case 'stock':
      return {
        ...base,
        columns: [
          { key: 'drug', type: 'text' },
          { key: 'onHand', type: 'integer' },
          { key: 'batches', type: 'integer' },
          { key: 'nearestExpiry', type: 'date' },
          { key: 'expiredOnHand', type: 'integer' },
          { key: 'valueMinor', type: 'money' },
        ],
        rows: [
          ['Paracetamol 500 mg', 1200, 3, '2027-02-28', 0, 360000],
          ['Amoxicillin 250 mg', 300, 1, '2026-10-31', 40, 90000],
        ],
        totals: [null, 1500, null, null, 40, 450000],
      };
  }
}

/** A stored report as the list gives it: how far the job has got follows the reads by id. */
function shown(run: Stored): Run {
  const { tenantId: _tenantId, reads, willFail, ...rest } = run;
  void _tenantId;
  if (run.status === 'succeeded' || run.status === 'failed') return rest;
  const status = reads < 1 ? 'queued' : reads < 2 ? 'running' : willFail ? 'failed' : 'succeeded';
  return {
    ...rest,
    status,
    ...(status === 'failed' ? { failure: willFail } : {}),
    ...(status === 'succeeded' ? { rowCount: 3, finishedAt: new Date(NOW).toISOString() } : {}),
  };
}

const isKind = (value: unknown): value is Kind => KINDS.includes(value as Kind);

interface Body {
  from?: string;
  to?: string;
}

async function readDays(request: Request, kind: Kind, max: number) {
  const body = (await request.json().catch(() => ({}))) as Body;
  if (kind === 'stock') return { from: null, to: null };
  if (!body.from || !body.to)
    return { problem: error(400, 'validation_failed', 'Days are needed') };
  if (days(body.from, body.to) < 1) {
    return { problem: error(400, 'validation_failed', 'The days are the wrong way round') };
  }
  if (days(body.from, body.to) > max) {
    return { problem: error(422, 'range_too_long', 'Too many days') };
  }
  return { from: body.from, to: body.to };
}

export const reportsHandlers = [
  http.get('*/api/reports/limits', ({ request }) => {
    const access = authorize(request, { permission: 'report:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const own = runs.filter((run) => run.tenantId === access.tenantId);
    return HttpResponse.json<Limits>({
      maxConcurrent: 2,
      maxPerDay: 50,
      retentionDays: 30,
      active: own.filter((run) => ['queued', 'running'].includes(shown(run).status)).length,
      usedToday: quotaUsed ? 50 : own.length,
    });
  }),

  http.get('*/api/reports/runs', ({ request }) => {
    const access = authorize(request, { permission: 'report:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 100);
    const cursor = url.searchParams.get('cursor');
    // Tenant isolation: only the session's hospital's runs are ever considered, newest first.
    const visible = runs
      .filter((run) => run.tenantId === access.tenantId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    const start = cursor ? visible.findIndex((run) => run.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      items: visible.slice(start, start + limit).map(shown),
      nextCursor: visible[start + limit]?.id ?? null,
      total: visible.length,
    });
  }),

  http.get('*/api/reports/runs/:runId', ({ request, params }) => {
    const access = authorize(request, { permission: 'report:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const run = runs.find((each) => each.id === params.runId && each.tenantId === access.tenantId);
    if (!run) return error(404, 'report_run_not_found', 'No such report');
    run.reads += 1;
    const now = shown(run);
    return HttpResponse.json<Run>(
      now.status === 'succeeded' ? { ...now, result: result(run.kind, run.from, run.to) } : now,
    );
  }),

  http.get('*/api/reports/runs/:runId/download-url', ({ request, params }) => {
    const access = authorize(request, { permission: 'report:export', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const run = runs.find((each) => each.id === params.runId && each.tenantId === access.tenantId);
    if (!run) return error(404, 'report_run_not_found', 'No such report');
    if (shown(run).status !== 'succeeded') {
      return error(409, 'report_not_ready', 'The report is not ready');
    }
    return HttpResponse.json({
      url: `/report-files/${run.id}?expires=${Math.floor(NOW / 1000) + 300}&signature=mock`,
      expiresAt: new Date(NOW + 300_000).toISOString(),
    });
  }),

  http.post('*/api/reports/:kind/runs', async ({ request, params }) => {
    const access = authorize(request, { permission: 'report:export', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!isKind(params.kind)) return error(404, 'report_not_found', 'No such report');
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const scoped = `${access.tenantId}:${key}`;
    const known = keys.get(scoped);
    const earlier = runs.find((run) => run.id === known);
    if (earlier) return HttpResponse.json(shown(earlier), { status: 202 });
    const range = await readDays(request, params.kind, STORED_MAX_DAYS);
    if ('problem' in range) return range.problem;
    if (quotaUsed) {
      return HttpResponse.json(
        { error: { code: 'report_quota', message: 'Quota', requestId: 'req_mock' } },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    }
    const user = currentSession()?.user;
    const run: Stored = {
      id: `rep_${access.tenantId === TENANT_IDS.hospital ? 'h' : 'c'}_${nextId++}`,
      tenantId: access.tenantId,
      kind: params.kind,
      from: range.from,
      to: range.to,
      status: 'queued',
      requestedBy: { id: user?.id ?? '', name: user?.name ?? '' },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      reads: 0,
      ...(failNext ? { willFail: failNext } : {}),
    };
    failNext = null;
    runs.push(run);
    keys.set(scoped, run.id);
    return HttpResponse.json(shown(run), { status: 202 });
  }),

  http.post('*/api/reports/:kind', async ({ request, params }) => {
    const access = authorize(request, { permission: 'report:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!isKind(params.kind)) return error(404, 'report_not_found', 'No such report');
    const range = await readDays(request, params.kind, SPOT_MAX_DAYS);
    if ('problem' in range) return range.problem;
    if (busy) {
      return HttpResponse.json(
        { error: { code: 'report_busy', message: 'Busy', requestId: 'req_mock' } },
        { status: 429, headers: { 'Retry-After': '5' } },
      );
    }
    return HttpResponse.json<Result>(result(params.kind, range.from, range.to));
  }),
];
