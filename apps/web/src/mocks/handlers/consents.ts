import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { STANDARD_FIELDS } from '@/features/consents/schemas';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockPatient } from './patients';

type Schemas = components['schemas'];
type Consent = Schemas['Consent'];
type Certificate = Schemas['Certificate'];
type Field = Schemas['CertificateFieldDef'];

const FEATURE_FLAG = 'consents';

interface StoredConsent extends Consent {
  tenantId: string;
  body: unknown;
  signature?: string;
}
interface StoredCertificate extends Certificate {
  tenantId: string;
}
interface State {
  consents: StoredConsent[];
  certificates: StoredCertificate[];
  /** The fields a hospital set for a kind, by hospital and kind; absent means the standard ones. */
  formats: Map<string, Field[]>;
  created: number;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, string>;
  /** The reads of a consent's text, as the API's audit log would hold them. */
  audited: { tenantId: string; consentId: string }[];
}

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function seed(): State {
  const H = TENANT_IDS.hospital;
  return {
    consents: [
      {
        id: 'cns_h_1',
        tenantId: H,
        patientId: 'pth_00001',
        procedureName: 'Appendectomy',
        templateId: 'tpl_h_consent',
        templateVersion: 1,
        signerName: 'Asha Verma',
        signerRole: 'patient',
        signatureMethod: 'typed',
        signedAt: '2026-10-05T10:15:00.000Z',
        signedByName: 'Sample Doctor',
        body: {
          type: 'doc',
          content: [paragraph('I, Asha Verma, consent to Appendectomy at Sample Hospital.')],
        },
      },
    ],
    certificates: [
      {
        id: 'crt_h_1',
        tenantId: H,
        patientId: 'pth_00001',
        kind: 'medical',
        number: 'MED-2026-0001',
        issuedOn: '2026-10-06',
        fields: { diagnosis: 'Viral fever', restFrom: '2026-10-06', restTo: '2026-10-09' },
        layout: STANDARD_FIELDS.medical.map((field) => ({ ...field })),
        issuedByName: 'Sample Doctor',
        issuedAt: '2026-10-06T08:00:00.000Z',
      },
    ],
    formats: new Map(),
    created: 0,
    replies: new Map(),
    audited: [],
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** Which consents' texts were read, per hospital: tests read it. */
export function mockConsentAudit(tenantId: string) {
  return state.audited.filter((entry) => entry.tenantId === tenantId);
}

const PREFIX = { medical: 'MED', fitness: 'FIT', birth: 'BIR', death: 'DTH' } as const;
const KINDS = Object.keys(PREFIX);
const SIGNERS = ['patient', 'guardian', 'representative'];
const METHODS = ['drawn', 'typed'];
const SIGNATURE_PATH = /^[ML0-9 .,-]*$/;

const summary = ({ tenantId: _t, body: _b, signature: _s, ...consent }: StoredConsent): Consent =>
  consent;
const detail = (one: StoredConsent) => ({
  consent: summary(one),
  body: one.body,
  ...(one.signature !== undefined ? { signature: one.signature } : {}),
});
const NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
const TYPES = ['text', 'date', 'time', 'lines', 'select'];

const formatOf = (tenantId: string, kind: Certificate['kind']): Field[] =>
  state.formats.get(`${tenantId}:${kind}`) ?? STANDARD_FIELDS[kind].map((field) => ({ ...field }));
const formatView = (tenantId: string, kind: Certificate['kind']) => ({
  kind,
  fields: formatOf(tenantId, kind),
  custom: state.formats.has(`${tenantId}:${kind}`),
});

/** Whether a body is a list of fields the API would take. */
function validFields(value: unknown): value is Field[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return false;
  const names = new Set<string>();
  return value.every((field) => {
    if (typeof field !== 'object' || field === null) return false;
    const { name, label, type, required, options } = field as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME.test(name) || names.has(name)) return false;
    names.add(name);
    if (label !== undefined && (typeof label !== 'string' || !label || label.length > 100)) {
      return false;
    }
    if (typeof type !== 'string' || !TYPES.includes(type) || typeof required !== 'boolean') {
      return false;
    }
    return type !== 'select' || (Array.isArray(options) && options.length > 0);
  });
}

const certificateView = ({ tenantId: _t, ...certificate }: StoredCertificate): Certificate =>
  certificate;

function page<T extends { id: string }>(rows: T[], query: URLSearchParams) {
  const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100);
  const cursor = query.get('cursor');
  const start = cursor ? rows.findIndex((one) => one.id === cursor) : 0;
  if (start < 0) return undefined;
  return { items: rows.slice(start, start + limit), nextCursor: rows[start + limit]?.id ?? null };
}

const newest = <T extends { id: string }>(a: T & { at: string }, b: T & { at: string }) =>
  b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

export const consentsHandlers = [
  http.get('*/api/certificate-formats', ({ request }) => {
    const access = authorize(request, {
      permission: 'certificate:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    return HttpResponse.json({
      items: KINDS.map((kind) => formatView(access.tenantId, kind as Certificate['kind'])),
    });
  }),

  http.put('*/api/certificate-formats/:kind', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'certificate:configure',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const kind = String(params.kind);
    if (!KINDS.includes(kind)) return error(404, 'not_found', 'No such kind');
    const body = (await request.json().catch(() => null)) as { fields?: unknown } | null;
    if (!body || !validFields(body.fields)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    state.formats.set(`${access.tenantId}:${kind}`, body.fields);
    return HttpResponse.json(formatView(access.tenantId, kind as Certificate['kind']));
  }),

  http.delete('*/api/certificate-formats/:kind', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'certificate:configure',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const kind = String(params.kind);
    if (!KINDS.includes(kind)) return error(404, 'not_found', 'No such kind');
    state.formats.delete(`${access.tenantId}:${kind}`);
    return HttpResponse.json(formatView(access.tenantId, kind as Certificate['kind']));
  }),

  http.get('*/api/patients/:patientId/consents', ({ request, params }) => {
    const access = authorize(request, { permission: 'consent:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const rows = state.consents
      .filter((one) => one.tenantId === access.tenantId && one.patientId === patientId)
      .map((one) => ({ ...one, at: one.signedAt }))
      .sort(newest);
    const found = page(rows, new URL(request.url).searchParams);
    if (!found) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({ ...found, items: found.items.map(summary) });
  }),

  http.get('*/api/consents/:consentId', ({ request, params }) => {
    const access = authorize(request, { permission: 'consent:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = state.consents.find(
      (one) => one.id === params.consentId && one.tenantId === access.tenantId,
    );
    if (!found) return error(404, 'consent_not_found', 'No such consent');
    state.audited.push({ tenantId: access.tenantId, consentId: found.id });
    return HttpResponse.json(detail(found));
  }),

  http.post('*/api/patients/:patientId/consents', async ({ request, params }) => {
    const access = authorize(request, { permission: 'consent:sign', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
    if (
      !body ||
      !text(body.templateId) ||
      typeof body.templateVersion !== 'number' ||
      !text(body.procedureName) ||
      typeof body.body !== 'object' ||
      body.body === null ||
      !text(body.signerName) ||
      !SIGNERS.includes(String(body.signerRole)) ||
      !METHODS.includes(String(body.signatureMethod))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    // A signature is what the method says: a drawn one has path data, a typed one has none.
    const drawn = body.signatureMethod === 'drawn';
    if (
      drawn !== (typeof body.signature === 'string' && body.signature !== '') ||
      (typeof body.signature === 'string' && !SIGNATURE_PATH.test(body.signature))
    ) {
      return error(422, 'signature_invalid', 'The signature does not match its method');
    }
    const replyKey = `${access.tenantId}:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      state.created += 1;
      id = `cns_mock_${state.created}`;
      state.replies.set(replyKey, id);
      state.consents.push({
        id,
        tenantId: access.tenantId,
        patientId,
        procedureName: String(body.procedureName).trim(),
        templateId: String(body.templateId),
        templateVersion: body.templateVersion,
        signerName: String(body.signerName).trim(),
        signerRole: body.signerRole as Consent['signerRole'],
        signatureMethod: body.signatureMethod as Consent['signatureMethod'],
        signedAt: new Date().toISOString(),
        signedByName: currentSession()?.user.name ?? '',
        body: body.body,
        ...(drawn ? { signature: String(body.signature) } : {}),
      });
    }
    const stored = state.consents.find((one) => one.id === id) as StoredConsent;
    return HttpResponse.json(detail(stored), { status: 201 });
  }),

  http.get('*/api/patients/:patientId/certificates', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'certificate:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    const rows = state.certificates
      .filter((one) => one.tenantId === access.tenantId && one.patientId === patientId)
      .map((one) => ({ ...one, at: one.issuedAt }))
      .sort(newest);
    const found = page(rows, new URL(request.url).searchParams);
    if (!found) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({ ...found, items: found.items.map(certificateView) });
  }),

  http.post('*/api/patients/:patientId/certificates', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'certificate:issue',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const patientId = String(params.patientId);
    if (!mockPatient(access.tenantId, patientId)) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    const body = (await request.json().catch(() => null)) as {
      kind?: unknown;
      issuedOn?: unknown;
      fields?: unknown;
    } | null;
    if (
      !body ||
      !KINDS.includes(String(body.kind)) ||
      typeof body.issuedOn !== 'string' ||
      typeof body.fields !== 'object' ||
      body.fields === null
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const kind = body.kind as Certificate['kind'];
    // What is entered must fit the hospital's fields for the kind: no other, none missing.
    const layout = formatOf(access.tenantId, kind);
    const entered = body.fields as Record<string, unknown>;
    const known = new Set(layout.map((field) => field.name));
    if (
      Object.keys(entered).some((name) => !known.has(name)) ||
      layout.some((field) => field.required && !String(entered[field.name] ?? '').trim())
    ) {
      return error(422, 'certificate_fields_invalid', 'The fields do not fit the format');
    }
    const replyKey = `${access.tenantId}:${key}`;
    let id = state.replies.get(replyKey);
    if (!id) {
      state.created += 1;
      id = `crt_mock_${state.created}`;
      state.replies.set(replyKey, id);
      // In order for each kind, year and hospital.
      const year = body.issuedOn.slice(0, 4);
      const count = state.certificates.filter(
        (one) =>
          one.tenantId === access.tenantId && one.kind === kind && one.number.includes(`-${year}-`),
      ).length;
      state.certificates.push({
        id,
        tenantId: access.tenantId,
        patientId,
        kind,
        number: `${PREFIX[kind]}-${year}-${String(count + 1).padStart(4, '0')}`,
        issuedOn: body.issuedOn,
        fields: body.fields as Record<string, string>,
        layout,
        issuedByName: currentSession()?.user.name ?? '',
        issuedAt: new Date().toISOString(),
      });
    }
    const stored = state.certificates.find((one) => one.id === id) as StoredCertificate;
    return HttpResponse.json(certificateView(stored), { status: 201 });
  }),
];
