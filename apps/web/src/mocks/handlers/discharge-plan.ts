import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_LINES } from '@/shared/utils/text';
import { currentSession, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockAdmissionOf } from './admissions-flow';

type DischargePlan = components['schemas']['DischargePlan'];
type Kind = components['schemas']['DischargeClearanceKind'];

// The discharge plan of a stay (DS-01, #164). Planned endpoints: the real API has none yet
// (#169), so this mock is the only implementation and the discharge itself is refused here
// while a clearance is open (409 `clearance_pending`).

const FEATURE_FLAG = 'admissions';
/** One permission for each kind of clearance, as on the API. */
const CLEAR_PERMISSION: Record<string, string> = {
  nursing: 'discharge:clearNursing',
  pharmacy: 'discharge:clearPharmacy',
  lab: 'discharge:clearLab',
};
const KINDS: Kind[] = ['nursing', 'pharmacy', 'lab'];
const REQUIRED: Record<string, Kind[]> = {
  routine: ['nursing', 'pharmacy', 'lab'],
  referred: ['nursing', 'pharmacy', 'lab'],
  against_advice: ['nursing', 'pharmacy'],
  deceased: ['nursing', 'pharmacy'],
  absconded: [],
};

let plans = new Map<string, DischargePlan>();
let answered = new Map<string, DischargePlan>();

onMockReset(() => {
  plans = new Map();
  answered = new Map();
});

const slot = (tenantId: string, admissionId: string) => `${tenantId}:${admissionId}`;

function planOf(tenantId: string, admissionId: string): DischargePlan {
  const found = plans.get(slot(tenantId, admissionId));
  return (
    found ?? {
      admissionId,
      clearances: KINDS.map((kind) => ({ kind, status: 'pending' })),
      version: 1,
    }
  );
}

/** For the discharge in the admissions mock: the required clearances still open, or none. */
export function mockOpenClearances(
  tenantId: string,
  admissionId: string,
  dischargeType: string,
): Kind[] {
  const plan = planOf(tenantId, admissionId);
  return (REQUIRED[dischargeType] ?? []).filter(
    (kind) => plan.clearances.find((each) => each.kind === kind)?.status !== 'cleared',
  );
}

/** For tests: every clearance of a stay already done. */
export function clearMockStay(tenantId: string, admissionId: string): void {
  plans.set(slot(tenantId, admissionId), {
    ...planOf(tenantId, admissionId),
    clearances: KINDS.map((kind) => ({
      kind,
      status: 'cleared',
      clearedAt: new Date().toISOString(),
      clearedByName: 'Seed',
    })),
  });
}

const notFound = () => error(404, 'admission_not_found', 'No such admission');
const keyMissing = () => error(400, 'idempotency_key_required', 'An Idempotency-Key is required');

export const dischargePlanHandlers = [
  http.get('*/api/admissions/:admissionId/discharge-plan', ({ request, params }) => {
    const access = authorize(request, { permission: 'admission:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const admissionId = String(params.admissionId);
    if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
    return HttpResponse.json(planOf(access.tenantId, admissionId));
  }),

  http.put('*/api/admissions/:admissionId/discharge-plan', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'admission:discharge',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) return keyMissing();
    const admissionId = String(params.admissionId);
    if (!mockAdmissionOf(access.tenantId, admissionId)) return notFound();
    const repeat = answered.get(`${access.tenantId}:${key}`);
    if (repeat) return HttpResponse.json(repeat);
    const body = (await request.json().catch(() => null)) as { advice?: unknown } | null;
    if (
      !body ||
      typeof body.advice !== 'string' ||
      body.advice.trim() === '' ||
      body.advice.length > 1000 ||
      !PLAIN_LINES.test(body.advice)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const before = planOf(access.tenantId, admissionId);
    const after = { ...before, advice: body.advice.trim(), version: before.version + 1 };
    plans.set(slot(access.tenantId, admissionId), after);
    answered.set(`${access.tenantId}:${key}`, after);
    return HttpResponse.json(after);
  }),

  http.put(
    '*/api/admissions/:admissionId/discharge-plan/clearances/:kind',
    async ({ request, params }) => {
      const access = authorize(request, {
        permission: CLEAR_PERMISSION[String(params.kind)] ?? 'discharge:clearNursing',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in access) return access.denied;
      const key = request.headers.get('idempotency-key');
      if (key === null) return keyMissing();
      const admissionId = String(params.admissionId);
      const found = mockAdmissionOf(access.tenantId, admissionId);
      if (!found) return notFound();
      const kind = String(params.kind) as Kind;
      const repeat = answered.get(`${access.tenantId}:${key}`);
      if (repeat) return HttpResponse.json(repeat);
      const body = (await request.json().catch(() => null)) as {
        status?: unknown;
        note?: unknown;
      } | null;
      if (
        !KINDS.includes(kind) ||
        !body ||
        (body.status !== 'pending' && body.status !== 'cleared') ||
        (body.note !== undefined &&
          (typeof body.note !== 'string' ||
            body.note.trim() === '' ||
            body.note.length > 500 ||
            !PLAIN_LINES.test(body.note)))
      ) {
        return error(400, 'validation_failed', 'The request is not valid');
      }
      if (found.admission.status !== 'admitted') {
        return error(409, 'invalid_transition', 'The patient is already discharged');
      }
      const before = planOf(access.tenantId, admissionId);
      const cleared = body.status === 'cleared';
      const after: DischargePlan = {
        ...before,
        clearances: before.clearances.map((each) =>
          each.kind !== kind
            ? each
            : cleared
              ? {
                  kind,
                  status: 'cleared',
                  ...(typeof body.note === 'string' ? { note: body.note.trim() } : {}),
                  clearedAt: new Date().toISOString(),
                  clearedByName: currentSession()?.user.name ?? '',
                }
              : { kind, status: 'pending' },
        ),
        version: before.version + 1,
      };
      plans.set(slot(access.tenantId, admissionId), after);
      answered.set(`${access.tenantId}:${key}`, after);
      return HttpResponse.json(after);
    },
  ),
];
