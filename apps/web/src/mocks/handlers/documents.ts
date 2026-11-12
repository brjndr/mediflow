import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockPatient, registerMockMergeCounter } from './patients';

type Schemas = components['schemas'];
type PatientDocument = Schemas['PatientDocument'];

const FEATURE_FLAG = 'documents';
const TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_BYTES = 25 * 1024 * 1024;

interface Stored extends Omit<PatientDocument, 'held'> {
  tenantId: string;
}
interface State {
  documents: Stored[];
  created: number;
  /** Years kept by hospital and category; absent means for ever. */
  retention: Map<string, number>;
  holds: (Schemas['DocumentLegalHold'] & { tenantId: string })[];
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, string>;
  /** Every view of a file, as the API's audit log would hold it: the id and what was done. */
  audited: { tenantId: string; documentId: string; action: 'read' | 'export' }[];
}

function seed(): State {
  const H = TENANT_IDS.hospital;
  const base = {
    tenantId: H,
    patientId: 'pth_00001',
    contentType: 'application/pdf',
    version: 1,
  };
  return {
    documents: [
      {
        ...base,
        id: 'doc_h_1',
        category: 'outside_report',
        title: 'Chest X-ray from another hospital',
        fileName: 'chest-xray.pdf',
        size: 482_000,
        status: 'clean',
        createdAt: '2026-10-01T09:30:00.000Z',
      },
      {
        ...base,
        id: 'doc_h_2',
        category: 'consent',
        title: 'Signed consent for surgery',
        fileName: 'consent.pdf',
        size: 120_000,
        status: 'clean',
        retainUntil: '2036-10-02',
        createdAt: '2026-10-02T11:00:00.000Z',
      },
      {
        ...base,
        id: 'doc_h_3',
        category: 'insurance',
        title: 'Insurance card',
        fileName: 'card.png',
        contentType: 'image/png',
        size: 90_000,
        status: 'scanning',
        createdAt: '2026-10-03T08:00:00.000Z',
      },
    ],
    created: 0,
    retention: new Map([[H + ':consent', 10]]),
    holds: [],
    replies: new Map(),
    audited: [],
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** What the audit log would hold for documents of a hospital: tests read it. */
export function mockDocumentAudit(tenantId: string) {
  return state.audited.filter((entry) => entry.tenantId === tenantId);
}

/** What the malware scan does meanwhile: the file may now be opened. */
export function finishMockScan(id: string, status: PatientDocument['status'] = 'clean'): void {
  const found = state.documents.find((one) => one.id === id);
  if (!found) throw new Error(`Unknown mock document: ${id}`);
  found.status = status;
}

/** A hold placed straight in the mock, as another hospital's staff would (tests). */
export function holdMockDocument(tenantId: string, patientId: string, documentId?: string): void {
  state.holds.push({
    id: 'hold_x' + String(state.holds.length + 1),
    tenantId,
    patientId,
    ...(documentId ? { documentId } : {}),
    reason: 'Test',
    placedAt: new Date().toISOString(),
  });
}

registerMockMergeCounter(
  'documents',
  (tenantId, patientId) =>
    state.documents.filter((one) => one.tenantId === tenantId && one.patientId === patientId)
      .length,
);

/** Held while an active hold covers the document or every document of its patient (#672). */
const view = ({ tenantId, ...document }: Stored): PatientDocument => ({
  ...document,
  held: state.holds.some(
    (hold) =>
      hold.tenantId === tenantId &&
      !hold.releasedAt &&
      (hold.documentId === document.id ||
        (!hold.documentId && hold.patientId === document.patientId)),
  ),
});

const CATEGORIES = [
  'consent',
  'referral_letter',
  'outside_report',
  'id_proof',
  'insurance',
  'certificate',
  'other',
];

async function placeMockHold(
  request: Request,
  tenantId: string,
  patientId: string,
  documentId?: string,
) {
  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
  if (!body || typeof body.reason !== 'string' || !body.reason.trim()) {
    return error(400, 'validation_failed', 'A reason is needed');
  }
  state.holds.push({
    id: 'hold_' + String(state.holds.length + 1),
    tenantId,
    patientId,
    ...(documentId ? { documentId } : {}),
    reason: body.reason.trim(),
    placedAt: new Date().toISOString(),
  });
  const { tenantId: _tenantId, ...hold } = state.holds[state.holds.length - 1]!;
  return HttpResponse.json(hold, { status: 201 });
}

export const documentsHandlers = [
  http.get('*/api/document-retention', ({ request }) => {
    const access = authorize(request, {
      permission: 'documentRetention:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    return HttpResponse.json({
      items: CATEGORIES.map((category) => ({
        category,
        years: state.retention.get(access.tenantId + ':' + category) ?? null,
      })),
    });
  }),

  http.put('*/api/document-retention/:category', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'documentRetention:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const category = String(params.category);
    const body = (await request.json().catch(() => null)) as { years?: unknown } | null;
    const years = body?.years;
    const valid =
      years === null ||
      (typeof years === 'number' && Number.isInteger(years) && years >= 1 && years <= 100);
    if (!CATEGORIES.includes(category) || !valid) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const key = access.tenantId + ':' + category;
    if (years === null) state.retention.delete(key);
    else state.retention.set(key, years);
    return HttpResponse.json({ category, years });
  }),

  http.get('*/api/patients/:patientId/documents', ({ request, params }) => {
    const access = authorize(request, { permission: 'document:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    const query = new URL(request.url).searchParams;
    const category = query.get('category');
    const includeRetired = query.get('includeRetired') === 'true';
    const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100);
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = state.documents
      .filter((one) => one.tenantId === access.tenantId && one.patientId === patientId)
      .filter((one) => !category || one.category === category)
      .filter((one) => includeRetired || !one.retiredAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const cursor = query.get('cursor');
    const start = cursor ? visible.findIndex((one) => one.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const page = visible.slice(start, start + limit);
    for (const one of page) {
      state.audited.push({ tenantId: access.tenantId, documentId: one.id, action: 'read' });
    }
    return HttpResponse.json({
      items: page.map(view),
      nextCursor: visible[start + limit]?.id ?? null,
    });
  }),

  http.post('*/api/patients/:patientId/documents', async ({ request, params }) => {
    const access = authorize(request, { permission: 'document:upload', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      typeof body.fileName !== 'string' ||
      typeof body.contentType !== 'string' ||
      typeof body.size !== 'number'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (!TYPES.includes(body.contentType)) {
      return error(422, 'file_type_not_allowed', 'Accepted types: JPEG, PNG, PDF');
    }
    if (body.size > MAX_BYTES) return error(422, 'file_too_large', 'Too large');
    const replyKey = `${access.tenantId}:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      state.created += 1;
      id = `doc_mock_${state.created}`;
      state.replies.set(replyKey, id);
      state.documents.push({
        id,
        tenantId: access.tenantId,
        patientId,
        category: body.category as PatientDocument['category'],
        title: body.title.trim(),
        fileName: body.fileName,
        contentType: body.contentType,
        size: body.size,
        status: 'pending',
        version: 1,
        createdAt: new Date().toISOString(),
      });
    }
    const document = state.documents.find((one) => one.id === id) as Stored;
    return HttpResponse.json(
      {
        document: view(document),
        uploadUrl: `/document-uploads/${id}?expires=9999999999&signature=mock`,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
      { status: 201 },
    );
  }),

  // Public, as in the API: the signed address is the credential. The mock holds the file as
  // scanned at once.
  http.put('*/api/document-uploads/:documentId', async ({ request, params }) => {
    const found = state.documents.find((one) => one.id === params.documentId);
    if (!found || found.status !== 'pending') {
      return error(404, 'document_file_not_found', 'No such file');
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== found.size) return error(400, 'size_mismatch', 'Wrong size');
    found.status = 'clean';
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/documents/:documentId/download-url', ({ request, params }) => {
    const access = authorize(request, { permission: 'document:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = state.documents.find(
      (one) => one.id === params.documentId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'document_not_found', 'No such document');
    if (found.status === 'pending' || found.status === 'scanning') {
      return error(409, 'document_not_ready', 'The file has not been scanned yet');
    }
    if (found.status !== 'clean') {
      return error(409, 'document_blocked', 'The file cannot be downloaded');
    }
    state.audited.push({ tenantId: access.tenantId, documentId: found.id, action: 'export' });
    return HttpResponse.json({
      url: `/document-files/${found.id}?expires=9999999999&signature=mock`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  }),

  http.get('*/api/document-files/:documentId', () =>
    HttpResponse.text('%PDF-1.4 mock', { headers: { 'Content-Type': 'application/pdf' } }),
  ),

  http.get('*/api/legal-holds', ({ request }) => {
    const access = authorize(request, {
      permission: 'documentRetention:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const items = state.holds
      .filter((one) => one.tenantId === access.tenantId && !one.releasedAt)
      .map(({ tenantId: _tenantId, ...hold }) => hold)
      .reverse();
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post('*/api/documents/:documentId/legal-hold', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'documentRetention:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const found = state.documents.find(
      (one) => one.id === params.documentId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'document_not_found', 'No such document');
    return placeMockHold(request, access.tenantId, found.patientId, found.id);
  }),

  http.post('*/api/patients/:patientId/legal-hold', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'documentRetention:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (!mockPatient(access.tenantId, String(params.patientId))) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    return placeMockHold(request, access.tenantId, String(params.patientId));
  }),

  http.post('*/api/legal-holds/:holdId/release', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'documentRetention:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const hold = state.holds.find(
      (one) => one.id === params.holdId && one.tenantId === access.tenantId,
    );
    if (!hold) return error(404, 'hold_not_found', 'No such hold');
    if (hold.releasedAt) return error(409, 'already_released', 'Already released');
    hold.releasedAt = new Date().toISOString();
    const { tenantId: _tenantId, ...view } = hold;
    return HttpResponse.json(view);
  }),

  http.post('*/api/documents/:documentId/retire', async ({ request, params }) => {
    const access = authorize(request, { permission: 'document:retire', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = state.documents.find(
      (one) => one.id === params.documentId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'document_not_found', 'No such document');
    const body = (await request.json().catch(() => null)) as {
      reason?: unknown;
      expectedVersion?: unknown;
    } | null;
    if (!body || typeof body.reason !== 'string' || !body.reason.trim()) {
      return error(400, 'validation_failed', 'A reason is needed');
    }
    if (found.retiredAt) return error(409, 'already_retired', 'Already retired');
    if (body.expectedVersion !== found.version) {
      return error(409, 'conflict', 'The document has changed since it was read');
    }
    found.retiredAt = new Date().toISOString();
    found.retiredReason = body.reason.trim();
    found.version += 1;
    return HttpResponse.json(view(found));
  }),
];
