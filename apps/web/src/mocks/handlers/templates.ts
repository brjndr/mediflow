import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
// The placeholder rules are one file, shared with the screen, so the two cannot disagree.
import {
  TEMPLATE_KINDS,
  unknownPlaceholders,
  type TemplateKind,
} from '@/features/templates/placeholders';
import {
  isEmptyRichText,
  sanitizeRichText,
  type RichTextDocument,
  type RichTextNode,
} from '@/shared/ui/rich-text';

type Schemas = components['schemas'];
type Template = Schemas['Template'];
type TemplatePage = Schemas['TemplatePage'];
type TemplateDetail = Schemas['TemplateDetail'];
type TemplateVersion = Schemas['TemplateVersion'];

const FEATURE_FLAG = 'templates';
const READ = 'template:read';
const MANAGE = 'template:manage';
const REDACT = 'template:redact';
const REDACTION_REASONS = ['patient_data', 'personal_data', 'confidential', 'other'] as const;

/** One saved version. Never changed once it is in the list, except to redact it. */
interface Saved {
  version: number;
  name: string;
  body: RichTextDocument;
  savedAt: string;
  savedByName: string;
  /** Set by a redaction, which empties the name and the text. */
  redactedAt?: string;
  redactedByName?: string;
  redactionReason?: (typeof REDACTION_REASONS)[number];
}
interface Stored {
  id: string;
  tenantId: string;
  kind: TemplateKind;
  archived: boolean;
  /** Oldest first. */
  versions: Saved[];
}
interface State {
  templates: Stored[];
  created: number;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, { raw: string; id: string }>;
}

const text = (value: string): RichTextNode => ({ type: 'text', text: value });
const doc = (...lines: string[]): RichTextDocument => ({
  type: 'doc',
  content: lines.map((line) => ({ type: 'paragraph', content: [text(line)] })),
});

function seed(): State {
  const templates: Stored[] = [];
  const add = (
    tenantId: string,
    id: string,
    kind: TemplateKind,
    name: string,
    bodies: RichTextDocument[],
    archived = false,
  ) =>
    templates.push({
      id,
      tenantId,
      kind,
      archived,
      versions: bodies.map((body, index) => ({
        version: index + 1,
        name,
        body,
        savedAt: `2026-0${index + 1}-15T09:30:00.000Z`,
        savedByName: 'Sample Admin',
      })),
    });
  const H = TENANT_IDS.hospital;
  add(H, 'tpl_h_rx', 'prescription', 'Standard prescription', [
    doc('{{hospital.name}}', 'Patient: {{patient.name}}', 'Rx'),
    doc(
      '{{hospital.name}}',
      'Patient: {{patient.name}} ({{patient.mrn}}), {{patient.age}}, {{patient.sex}}',
      'Date: {{date.today}}',
      'Rx',
      'Prescribed by {{doctor.name}}',
    ),
  ]);
  add(H, 'tpl_h_note', 'clinical_note', 'OPD consultation note', [
    doc(
      'Complaints',
      'History',
      'Examination',
      'Plan',
      'Seen by {{doctor.name}} on {{date.today}}',
    ),
  ]);
  add(H, 'tpl_h_consent', 'consent', 'Consent for a procedure', [
    doc(
      'I, {{patient.name}}, consent to {{procedure.name}} at {{hospital.name}}.',
      'The procedure, its risks and the alternatives have been explained to me by {{doctor.name}}.',
      'Date: {{date.today}}',
    ),
  ]);
  add(H, 'tpl_h_general', 'consent', 'General consent to treatment', [
    doc('I, {{patient.name}}, consent to examination and treatment at {{hospital.name}}.'),
  ]);
  add(H, 'tpl_h_discharge', 'discharge_summary', 'Discharge summary', [
    doc('Discharge summary', 'Patient: {{patient.name}}'),
    doc('Discharge summary', 'Patient: {{patient.name}} ({{patient.mrn}})'),
    doc(
      'Discharge summary',
      'Patient: {{patient.name}} ({{patient.mrn}})',
      'Admitted {{admission.date}}, discharged {{discharge.date}}',
      'Diagnosis',
      'Course in hospital',
      'Advice on discharge',
      '{{doctor.name}}',
    ),
  ]);
  add(
    H,
    'tpl_h_old',
    'prescription',
    'Old prescription pad',
    [doc('Rx for {{patient.name}}')],
    true,
  );
  // The clinic has its own, with a name the hospital uses too.
  add(TENANT_IDS.clinic, 'tpl_c_rx', 'prescription', 'Standard prescription', [
    doc('Riverside prescription for {{patient.name}}'),
  ]);
  return { templates, created: 0, replies: new Map() };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** What another member of staff does meanwhile: saves a new version behind the open screen. */
export function saveMockTemplateVersion(id: string, lines: string[]): void {
  const template = state.templates.find((candidate) => candidate.id === id);
  const last = template?.versions.at(-1);
  if (!template || !last) throw new Error(`Unknown mock template: ${id}`);
  template.versions.push({
    version: last.version + 1,
    name: last.name,
    body: doc(...lines),
    savedAt: new Date().toISOString(),
    savedByName: 'Someone Else',
  });
}

const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const notFound = () => error(404, 'template_not_found', 'No such template');

/** A template of another hospital does not exist as far as this session is concerned. */
const find = (tenantId: string, id: unknown) =>
  state.templates.find((candidate) => candidate.id === id && candidate.tenantId === tenantId);

const newest = (template: Stored): Saved => {
  const last = template.versions.at(-1);
  if (!last) throw new Error('A template always has a version');
  return last;
};

function summary(template: Stored): Template {
  const last = newest(template);
  return {
    id: template.id,
    tenantId: template.tenantId,
    kind: template.kind,
    name: last.name,
    version: last.version,
    savedAt: last.savedAt,
    archived: template.archived,
  };
}

const asBody = (body: RichTextDocument) => body as unknown as Record<string, unknown>;

function detail(template: Stored): TemplateDetail {
  return {
    template: summary(template),
    body: asBody(newest(template).body),
    versions: [...template.versions]
      .reverse()
      .map(({ version, savedAt, savedByName, redactedAt }) => ({
        version,
        savedAt,
        savedByName,
        ...(redactedAt ? { redactedAt } : {}),
      })),
  };
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

const readName = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.trim().length <= 100
    ? value.trim()
    : null;

/** The text of a request, reduced to what a document may hold and checked. Null when refused. */
function readText(kind: TemplateKind, value: unknown): RichTextDocument | null {
  const body = sanitizeRichText(value);
  if (isEmptyRichText(body) || unknownPlaceholders(kind, body).length > 0) return null;
  return body;
}

/** A name is one template of its kind at a hospital, whatever the capitals, archived or not. */
const nameTaken = (tenantId: string, kind: TemplateKind, name: string, except?: string) =>
  state.templates.some(
    (other) =>
      other.id !== except &&
      other.tenantId === tenantId &&
      other.kind === kind &&
      newest(other).name.toLowerCase() === name.toLowerCase(),
  );

const collator = new Intl.Collator('en', { sensitivity: 'base' });

export const templatesHandlers = [
  http.get('*/api/templates', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const kind = params.get('kind');
    const archived = params.get('archived') === 'true';
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = state.templates
      .filter((template) => template.tenantId === access.tenantId && template.archived === archived)
      .filter((template) => !kind || template.kind === kind)
      .map(summary)
      .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
    const limit = Math.min(Math.max(Number(params.get('limit')) || 25, 1), 100);
    const cursor = params.get('cursor');
    const start = cursor ? visible.findIndex((template) => template.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[start + limit];
    return HttpResponse.json<TemplatePage>({
      items: visible.slice(start, start + limit),
      nextCursor: next?.id ?? null,
      // With the first page only, as the contract says.
      ...(cursor ? {} : { total: visible.length }),
    });
  }),

  http.post('*/api/templates', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const raw = await request.clone().text();
    // The same key with the same request is answered as before, and nothing is added again.
    const key = request.headers.get('idempotency-key');
    const earlier = key ? state.replies.get(`${access.tenantId}:${key}`) : undefined;
    if (earlier) {
      const template = find(access.tenantId, earlier.id);
      return earlier.raw === raw && template
        ? HttpResponse.json<TemplateDetail>(detail(template), {
            status: 201,
            headers: { 'Idempotent-Replayed': 'true' },
          })
        : error(422, 'idempotency_key_reuse', 'That key was used for another request');
    }
    const body = await readBody(request);
    const kind = TEMPLATE_KINDS.find((value) => value === body?.kind);
    const name = readName(body?.name);
    const content = kind ? readText(kind, body?.body) : null;
    if (!kind || !name || !content) return invalid();
    if (nameTaken(access.tenantId, kind, name)) {
      return error(409, 'template_name_taken', 'A template of this kind has that name');
    }
    state.created += 1;
    const template: Stored = {
      id: `tpl_new_${state.created}`,
      tenantId: access.tenantId,
      kind,
      archived: false,
      versions: [
        {
          version: 1,
          name,
          body: content,
          savedAt: new Date().toISOString(),
          savedByName: currentSession()?.user.name ?? '',
        },
      ],
    };
    state.templates.push(template);
    if (key) state.replies.set(`${access.tenantId}:${key}`, { raw, id: template.id });
    return HttpResponse.json<TemplateDetail>(detail(template), { status: 201 });
  }),

  http.get('*/api/templates/:templateId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const template = find(access.tenantId, params.templateId);
    return template ? HttpResponse.json<TemplateDetail>(detail(template)) : notFound();
  }),

  http.get('*/api/templates/:templateId/versions/:version', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const template = find(access.tenantId, params.templateId);
    if (!template) return notFound();
    const saved = template.versions.find((one) => String(one.version) === params.version);
    if (!saved) return error(404, 'template_version_not_found', 'No such version');
    return HttpResponse.json<TemplateVersion>({ ...saved, body: asBody(saved.body) });
  }),

  http.put('*/api/templates/:templateId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (!body || typeof body.expectedVersion !== 'number') return invalid();
    const template = find(access.tenantId, params.templateId);
    if (!template) return notFound();
    // An archived template is restored before it is given a new version.
    if (template.archived) return error(409, 'template_archived', 'The template is archived');
    const last = newest(template);
    if (last.version !== body.expectedVersion) return error(409, 'conflict', 'A newer version');
    const name = body.name === undefined ? last.name : readName(body.name);
    const content = body.body === undefined ? last.body : readText(template.kind, body.body);
    if (!name || !content) return invalid();
    if (nameTaken(access.tenantId, template.kind, name, template.id)) {
      return error(409, 'template_name_taken', 'A template of this kind has that name');
    }
    // What the newest version already has makes no new version. Otherwise one is added: the
    // versions before it are never touched.
    if (name !== last.name || JSON.stringify(content) !== JSON.stringify(last.body)) {
      template.versions.push({
        version: last.version + 1,
        name,
        body: content,
        savedAt: new Date().toISOString(),
        savedByName: currentSession()?.user.name ?? '',
      });
    }
    return HttpResponse.json<TemplateDetail>(detail(template));
  }),

  http.post('*/api/templates/:templateId/versions/:version/redact', async ({ request, params }) => {
    const access = authorize(request, { permission: REDACT, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const reason = REDACTION_REASONS.find((value) => value === body?.reason);
    if (!reason) return invalid();
    const template = find(access.tenantId, params.templateId);
    if (!template) return notFound();
    const saved = template.versions.find((one) => String(one.version) === params.version);
    if (!saved) return error(404, 'template_version_not_found', 'No such version');
    // The newest version is the template as it is used: a corrected one is saved first.
    if (saved === newest(template)) {
      return error(409, 'template_version_current', 'The newest version is not redacted');
    }
    // Twice changes nothing.
    if (!saved.redactedAt) {
      saved.name = '';
      saved.body = { type: 'doc', content: [] };
      saved.redactedAt = new Date().toISOString();
      saved.redactedByName = currentSession()?.user.name ?? '';
      saved.redactionReason = reason;
    }
    return HttpResponse.json<TemplateDetail>(detail(template));
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/templates/:templateId/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const template = find(access.tenantId, params.templateId);
      if (!template) return notFound();
      // Doing it twice is harmless, and neither makes a version.
      template.archived = action === 'archive';
      return HttpResponse.json<TemplateDetail>(detail(template));
    }),
  ),
];
