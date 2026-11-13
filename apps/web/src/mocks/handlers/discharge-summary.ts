import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_LINES } from '@/shared/utils/text';
import { currentSession, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockAdmissionOf } from './admissions-flow';

type Summary = components['schemas']['DischargeSummary'];

// The discharge summary of a stay (DS-02, #165). Planned endpoints: the real API has none yet
// (#169), so this mock is the only implementation. A signed summary is never changed again; a
// correction is an addendum.

const FEATURE_FLAG = 'admissions';
const SECTIONS = ['diagnoses', 'procedures', 'course', 'results', 'medicines', 'followUp'] as const;

let summaries = new Map<string, Summary>();
let answered = new Map<string, Summary>();
let counter = 0;

onMockReset(() => {
  summaries = new Map();
  answered = new Map();
  counter = 0;
});

const slot = (tenantId: string, admissionId: string) => `${tenantId}:${admissionId}`;

/** For tests: a summary already signed for a stay. */
export function addMockSignedSummary(
  tenantId: string,
  admissionId: string,
  texts: Partial<Record<(typeof SECTIONS)[number], string>> = {},
): void {
  summaries.set(slot(tenantId, admissionId), {
    admissionId,
    status: 'signed',
    diagnoses: 'Community acquired pneumonia',
    procedures: '',
    course: 'Treated with antibiotics and recovered.',
    results: '',
    medicines: '',
    followUp: '',
    ...texts,
    signedAt: new Date().toISOString(),
    signedByName: 'Dr. Seed',
    addenda: [],
    version: 2,
  });
}

const notFound = () => error(404, 'admission_not_found', 'No such admission');
const keyMissing = () => error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
const invalid = () => error(400, 'validation_failed', 'The request is not valid');

const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && PLAIN_LINES.test(value);

export const dischargeSummaryHandlers = [
  http.get('*/api/admissions/:admissionId/discharge-summary', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'dischargeSummary:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const admissionId = String(params.admissionId);
    if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
    const found = summaries.get(slot(access.tenantId, admissionId));
    return found
      ? HttpResponse.json(found)
      : error(404, 'summary_not_found', 'No summary has been started');
  }),

  http.put('*/api/admissions/:admissionId/discharge-summary', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'dischargeSummary:create',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) return keyMissing();
    const admissionId = String(params.admissionId);
    if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
    const repeat = answered.get(`${access.tenantId}:${key}`);
    if (repeat) return HttpResponse.json(repeat);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !SECTIONS.every((section) => validText(body[section], 4000))) return invalid();
    const before = summaries.get(slot(access.tenantId, admissionId));
    if (before?.status === 'signed') {
      return error(409, 'summary_signed', 'A signed summary cannot be changed');
    }
    if (before && body.version !== before.version) {
      return error(409, 'conflict', 'Someone changed the summary first');
    }
    const template = body.template as Summary['template'];
    const after: Summary = {
      admissionId,
      status: 'draft',
      ...(Object.fromEntries(SECTIONS.map((section) => [section, body[section]])) as Pick<
        Summary,
        (typeof SECTIONS)[number]
      >),
      ...(template ? { template } : {}),
      addenda: [],
      version: (before?.version ?? 0) + 1,
    };
    summaries.set(slot(access.tenantId, admissionId), after);
    answered.set(`${access.tenantId}:${key}`, after);
    return HttpResponse.json(after);
  }),

  http.post('*/api/admissions/:admissionId/discharge-summary/sign', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'dischargeSummary:sign',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) return keyMissing();
    const admissionId = String(params.admissionId);
    if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
    const repeat = answered.get(`${access.tenantId}:${key}`);
    if (repeat) return HttpResponse.json(repeat);
    const body = (await request.json().catch(() => null)) as { version?: unknown } | null;
    if (!body || typeof body.version !== 'number') return invalid();
    const before = summaries.get(slot(access.tenantId, admissionId));
    if (!before) return error(404, 'summary_not_found', 'No summary has been started');
    if (before.status === 'signed') {
      return error(409, 'summary_signed', 'A signed summary cannot be changed');
    }
    if (before.version !== body.version) {
      return error(409, 'conflict', 'Someone changed the summary first');
    }
    if (before.diagnoses.trim() === '' || before.course.trim() === '') {
      return error(422, 'summary_incomplete', 'Diagnoses and course are needed');
    }
    const after: Summary = {
      ...before,
      status: 'signed',
      signedAt: new Date().toISOString(),
      signedByName: currentSession()?.user.name ?? '',
      version: before.version + 1,
    };
    summaries.set(slot(access.tenantId, admissionId), after);
    answered.set(`${access.tenantId}:${key}`, after);
    return HttpResponse.json(after);
  }),

  http.post(
    '*/api/admissions/:admissionId/discharge-summary/addenda',
    async ({ request, params }) => {
      const access = authorize(request, {
        permission: 'dischargeSummary:sign',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in access) return access.denied;
      const key = request.headers.get('idempotency-key');
      if (key === null) return keyMissing();
      const admissionId = String(params.admissionId);
      if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
      const repeat = answered.get(`${access.tenantId}:${key}`);
      if (repeat) return HttpResponse.json(repeat);
      const body = (await request.json().catch(() => null)) as { body?: unknown } | null;
      if (!body || !validText(body.body, 2000) || body.body.trim() === '') return invalid();
      const before = summaries.get(slot(access.tenantId, admissionId));
      if (!before) return error(404, 'summary_not_found', 'No summary has been started');
      if (before.status !== 'signed') {
        return error(409, 'summary_not_signed', 'Only a signed summary has addenda');
      }
      counter += 1;
      const after: Summary = {
        ...before,
        addenda: [
          ...before.addenda,
          {
            id: `add_${counter}`,
            body: body.body.trim(),
            authorName: currentSession()?.user.name ?? '',
            createdAt: new Date().toISOString(),
          },
        ],
        version: before.version + 1,
      };
      summaries.set(slot(access.tenantId, admissionId), after);
      answered.set(`${access.tenantId}:${key}`, after);
      return HttpResponse.json(after);
    },
  ),

  http.post('*/api/admissions/:admissionId/discharge-summary/print', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'dischargeSummary:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (request.headers.get('idempotency-key') === null) return keyMissing();
    const admissionId = String(params.admissionId);
    if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
    const found = summaries.get(slot(access.tenantId, admissionId));
    if (found?.status !== 'signed') {
      return error(409, 'summary_not_signed', 'Only a signed summary is printed');
    }
    return new HttpResponse(null, { status: 204 });
  }),
];
