import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockCode } from './codes';
import { mockPatient } from './patients';

type Schemas = components['schemas'];
type Incomplete = Schemas['IncompleteRecord'];
type Coding = Schemas['CodingItem'];
type Request = Schemas['RecordRequest'];

const FEATURE_FLAG = 'records';

interface StoredIncomplete extends Incomplete {
  tenantId: string;
}
interface StoredCoding extends Coding {
  tenantId: string;
}
interface StoredRequest extends Request {
  tenantId: string;
}
interface State {
  incomplete: StoredIncomplete[];
  coding: StoredCoding[];
  requests: StoredRequest[];
  created: number;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, string>;
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const day = (daysAhead: number) =>
  new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

function named(tenantId: string, patientId: string) {
  const found = mockPatient(tenantId, patientId);
  return { patientId, patientName: found?.name ?? '', patientMrn: found?.mrn ?? '' };
}

/**
 * At the hospital: three incomplete records (the oldest has two gaps), two diagnoses waiting for
 * a code and one coded, one open request past its day, one open and one fulfilled. At the
 * clinic, one of each, so a list can be told apart by hospital.
 */
function seed(): State {
  const H = TENANT_IDS.hospital;
  const C = TENANT_IDS.clinic;
  const mk = (tenantId: string, patientId: string) => ({ tenantId, ...named(tenantId, patientId) });
  return {
    incomplete: [
      {
        ...mk(H, 'pth_00002'),
        encounterId: 'enc_h_2',
        kind: 'opd',
        closedAt: iso(9),
        doctorName: 'Sample Doctor',
        gaps: ['unsigned_note', 'no_diagnosis'],
      },
      {
        ...mk(H, 'pth_00003'),
        encounterId: 'enc_h_7',
        kind: 'ipd',
        closedAt: iso(5),
        doctorName: 'Sample Doctor',
        gaps: ['no_discharge_summary'],
      },
      {
        ...mk(H, 'pth_00004'),
        encounterId: 'enc_h_8',
        kind: 'daycare',
        closedAt: iso(2),
        doctorName: 'Sample Doctor',
        gaps: ['missing_consent'],
      },
      {
        ...mk(C, 'ptc_00001'),
        encounterId: 'enc_c_9',
        kind: 'opd',
        closedAt: iso(3),
        doctorName: 'Clinic Doctor',
        gaps: ['no_diagnosis'],
      },
    ],
    coding: [
      {
        ...mk(H, 'pth_00001'),
        diagnosisId: 'dgn_h_1',
        encounterId: 'enc_h_1',
        text: 'Viral fever with body ache',
        recordedAt: iso(6),
        doctorName: 'Sample Doctor',
        version: 1,
      },
      {
        ...mk(H, 'pth_00002'),
        diagnosisId: 'dgn_h_2',
        encounterId: 'enc_h_2',
        text: 'Type 2 diabetes, newly found',
        recordedAt: iso(4),
        doctorName: 'Sample Doctor',
        version: 1,
      },
      {
        ...mk(H, 'pth_00003'),
        diagnosisId: 'dgn_h_3',
        encounterId: 'enc_h_7',
        text: 'Hypertension',
        code: { ...(mockCode('icd10_i10') as NonNullable<Coding['code']>), favourite: true },
        recordedAt: iso(8),
        doctorName: 'Sample Doctor',
        version: 2,
      },
      {
        ...mk(C, 'ptc_00001'),
        diagnosisId: 'dgn_c_1',
        encounterId: 'enc_c_9',
        text: 'Seasonal allergy',
        recordedAt: iso(3),
        doctorName: 'Clinic Doctor',
        version: 1,
      },
    ],
    requests: [
      {
        ...mk(H, 'pth_00001'),
        id: 'rrq_h_1',
        requesterKind: 'insurer',
        requesterName: 'Sample Insurance Co',
        purpose: 'Claim for the October stay',
        requestedOn: day(-10),
        dueOn: day(-3),
        state: 'open',
        createdByName: 'Sample Admin',
        version: 1,
      },
      {
        ...mk(H, 'pth_00002'),
        id: 'rrq_h_2',
        requesterKind: 'patient',
        requesterName: 'Rohan Verma',
        purpose: 'A copy for a second opinion',
        requestedOn: day(-1),
        dueOn: day(6),
        state: 'open',
        createdByName: 'Sample Admin',
        version: 1,
      },
      {
        ...mk(H, 'pth_00003'),
        id: 'rrq_h_3',
        requesterKind: 'court',
        requesterName: 'District Court',
        purpose: 'Order dated 1 October',
        requestedOn: day(-20),
        state: 'fulfilled',
        createdByName: 'Sample Admin',
        closedAt: iso(15),
        closedByName: 'Sample Admin',
        note: 'Certified copy handed over',
        version: 2,
      },
      {
        ...mk(C, 'ptc_00001'),
        id: 'rrq_c_1',
        requesterKind: 'patient',
        requesterName: 'Clinic Patient',
        purpose: 'Personal copy',
        requestedOn: day(-2),
        state: 'open',
        createdByName: 'Clinic Admin',
        version: 1,
      },
    ],
    created: 0,
    replies: new Map(),
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

const strip = <T extends { tenantId: string }>({ tenantId: _t, ...rest }: T): Omit<T, 'tenantId'> =>
  rest;

function page<T extends { id: string }>(rows: T[], query: URLSearchParams) {
  const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100);
  const cursor = query.get('cursor');
  const start = cursor ? rows.findIndex((one) => one.id === cursor) : 0;
  if (start < 0) return undefined;
  return {
    items: rows.slice(start, start + limit),
    nextCursor: rows[start + limit]?.id ?? null,
    total: rows.length,
  };
}

export const recordsHandlers = [
  http.get('*/api/records/incomplete', ({ request }) => {
    const access = authorize(request, {
      permission: 'medicalRecord:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const gap = query.get('gap');
    const kind = query.get('kind');
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const rows = state.incomplete
      .filter(
        (one) =>
          one.tenantId === access.tenantId &&
          (!gap || one.gaps.includes(gap as Incomplete['gaps'][number])) &&
          (!kind || one.kind === kind),
      )
      .map((one) => ({ ...one, id: one.encounterId }))
      .sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    const found = page(rows, query);
    if (!found) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      ...found,
      items: found.items.map(({ id: _id, ...one }) => strip(one)),
    });
  }),

  http.get('*/api/records/coding-queue', ({ request }) => {
    const access = authorize(request, {
      permission: 'medicalRecord:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const coded = query.get('state') === 'coded';
    const rows = state.coding
      .filter((one) => one.tenantId === access.tenantId && (one.code !== undefined) === coded)
      .map((one) => ({ ...one, id: one.diagnosisId }))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const found = page(rows, query);
    if (!found) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      ...found,
      items: found.items.map(({ id: _id, ...one }) => strip(one)),
    });
  }),

  http.post('*/api/records/coding-queue/:diagnosisId/code', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'medicalRecord:code',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) {
      return error(400, 'validation_failed', 'Idempotency-Key is required');
    }
    const body = (await request.json().catch(() => null)) as {
      codeId?: unknown;
      version?: unknown;
    } | null;
    if (!body || typeof body.codeId !== 'string' || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const found = state.coding.find(
      (one) => one.diagnosisId === params.diagnosisId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'diagnosis_not_found', 'No such diagnosis');
    const code = mockCode(body.codeId);
    if (!code || code.system !== 'icd10') {
      return error(422, 'code_invalid', 'Not an ICD-10 code');
    }
    if (found.version !== body.version) {
      return error(409, 'version_conflict', 'The diagnosis changed');
    }
    found.code = { ...code, favourite: false };
    found.version += 1;
    return HttpResponse.json(strip(found));
  }),

  http.get('*/api/record-requests', ({ request }) => {
    const access = authorize(request, {
      permission: 'recordRequest:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const wanted = query.get('state');
    const rows = state.requests
      .filter((one) => one.tenantId === access.tenantId && (!wanted || one.state === wanted))
      .sort(
        (a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') || a.id.localeCompare(b.id),
      );
    const found = page(rows, query);
    if (!found) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({ ...found, items: found.items.map(strip) });
  }),

  http.post('*/api/record-requests', async ({ request }) => {
    const access = authorize(request, {
      permission: 'recordRequest:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
    if (
      !body ||
      !text(body.patientId) ||
      !text(body.requesterName) ||
      !text(body.purpose) ||
      !['patient', 'representative', 'insurer', 'court', 'hospital', 'other'].includes(
        String(body.requesterKind),
      )
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const patient = mockPatient(access.tenantId, String(body.patientId));
    if (!patient) return error(404, 'patient_not_found', 'No such patient');
    const replyKey = `${access.tenantId}:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      state.created += 1;
      id = `rrq_mock_${state.created}`;
      state.replies.set(replyKey, id);
      state.requests.push({
        id,
        tenantId: access.tenantId,
        patientId: patient.id,
        patientName: patient.name,
        patientMrn: patient.mrn,
        requesterKind: body.requesterKind as Request['requesterKind'],
        requesterName: String(body.requesterName).trim(),
        purpose: String(body.purpose).trim(),
        requestedOn: day(0),
        ...(typeof body.dueOn === 'string' && body.dueOn !== '' ? { dueOn: body.dueOn } : {}),
        state: 'open',
        createdByName: currentSession()?.user.name ?? '',
        version: 1,
      });
    }
    const stored = state.requests.find((one) => one.id === id) as StoredRequest;
    return HttpResponse.json(strip(stored), { status: 201 });
  }),

  http.post('*/api/record-requests/:requestId/close', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'recordRequest:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (!request.headers.get('Idempotency-Key')) {
      return error(400, 'validation_failed', 'Idempotency-Key is required');
    }
    const body = (await request.json().catch(() => null)) as {
      outcome?: unknown;
      note?: unknown;
      version?: unknown;
    } | null;
    if (
      !body ||
      !['fulfilled', 'declined'].includes(String(body.outcome)) ||
      typeof body.note !== 'string' ||
      body.note.trim() === '' ||
      typeof body.version !== 'number'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const found = state.requests.find(
      (one) => one.id === params.requestId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'record_request_not_found', 'No such request');
    if (found.state !== 'open') return error(409, 'already_closed', 'The request is closed');
    if (found.version !== body.version) {
      return error(409, 'version_conflict', 'The request changed');
    }
    found.state = body.outcome as Request['state'];
    found.note = body.note.trim();
    found.closedAt = new Date().toISOString();
    found.closedByName = currentSession()?.user.name ?? '';
    found.version += 1;
    return HttpResponse.json(strip(found));
  }),
];
