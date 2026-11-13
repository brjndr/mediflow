import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, tidyLines } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { findAdmission, type AdmissionRow } from './repository.js';
import { userIdOf } from './routes.js';
import { AdmissionParams } from './schemas.js';

/**
 * The discharge summary of a stay (DS-02, #165; API in BE-25, #169): six plain-text sections
 * written as a draft, then signed once. A signed summary is never changed (the database refuses
 * it); a correction is an addendum, which is appended and never edited. Reads, writes, the
 * signing, addenda and prints are audited; the text itself is never logged or put in an event.
 */
const FEATURE = 'admissions';
const READ = 'dischargeSummary:read';
const CREATE = 'dischargeSummary:create';
const SIGN = 'dischargeSummary:sign';
const SECTION_MAX = 4000;
const ADDENDUM_MAX = 2000;

const SECTIONS = ['diagnoses', 'procedures', 'course', 'results', 'medicines', 'followUp'] as const;
type Section = (typeof SECTIONS)[number];

const Text = () => Type.String({ maxLength: SECTION_MAX, pattern: PLAIN_LINES });
const TemplateRef = Type.Object(
  { id: Type.String({ maxLength: 64 }), version: Type.Integer({ minimum: 1 }) },
  {
    additionalProperties: false,
    description: 'The discharge_summary template the text was started from.',
  },
);

export const DischargeSummaryAddendum = Type.Object(
  {
    id: Type.String(),
    body: Type.String({ maxLength: ADDENDUM_MAX }),
    authorName: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'DischargeSummaryAddendum', additionalProperties: false },
);

export const DischargeSummary = Type.Object(
  {
    admissionId: Type.String(),
    status: Type.Unsafe<'draft' | 'signed'>({ type: 'string', enum: ['draft', 'signed'] }),
    diagnoses: Type.String({ maxLength: SECTION_MAX }),
    procedures: Type.String({ maxLength: SECTION_MAX }),
    course: Type.String({ maxLength: SECTION_MAX }),
    results: Type.String({ maxLength: SECTION_MAX }),
    medicines: Type.String({ maxLength: SECTION_MAX }),
    followUp: Type.String({ maxLength: SECTION_MAX }),
    template: Type.Optional(TemplateRef),
    signedAt: Type.Optional(Type.String({ format: 'date-time' })),
    signedByName: Type.Optional(Type.String()),
    addenda: Type.Array(ref(DischargeSummaryAddendum)),
    version: Type.Integer({ minimum: 1 }),
  },
  { $id: 'DischargeSummary', additionalProperties: false },
);

export const DischargeSummarySave = Type.Object(
  {
    diagnoses: Text(),
    procedures: Text(),
    course: Text(),
    results: Text(),
    medicines: Text(),
    followUp: Text(),
    template: Type.Optional(TemplateRef),
    version: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: 'The version the edit started from; absent while no draft exists.',
      }),
    ),
  },
  { $id: 'DischargeSummarySave', additionalProperties: false },
);

export const DischargeSummarySign = Type.Object(
  { version: Type.Integer({ minimum: 1 }) },
  { $id: 'DischargeSummarySign', additionalProperties: false },
);

export const DischargeSummaryAddendumCreate = Type.Object(
  { body: Type.String({ minLength: 1, maxLength: ADDENDUM_MAX, pattern: PLAIN_LINES }) },
  { $id: 'DischargeSummaryAddendumCreate', additionalProperties: false },
);

type Save = Static<typeof DischargeSummarySave>;

export const DISCHARGE_SUMMARY_SCHEMAS = [
  DischargeSummaryAddendum,
  DischargeSummary,
  DischargeSummarySave,
  DischargeSummarySign,
  DischargeSummaryAddendumCreate,
] as const;

interface SummaryRow {
  status: 'draft' | 'signed';
  diagnoses: string;
  procedures: string;
  course: string;
  results: string;
  medicines: string;
  follow_up: string;
  template_id: string | null;
  template_version: number | null;
  version: number;
  signed_at: Date | null;
  signed_by_name: string | null;
}

async function summaryOf(
  client: pg.ClientBase,
  admissionId: string,
  forUpdate = false,
): Promise<SummaryRow | null> {
  const { rows } = await client.query<SummaryRow>(
    `select s.status, s.diagnoses, s.procedures, s.course, s.results, s.medicines, s.follow_up,
       s.template_id, s.template_version, s.version, s.signed_at, u.name as signed_by_name
     from discharge_summaries s left join users u on u.id = s.signed_by
     where s.admission_id = $1${forUpdate ? ' for update of s' : ''}`,
    [admissionId],
  );
  return rows[0] ?? null;
}

async function view(client: pg.ClientBase, admissionId: string, row: SummaryRow) {
  const { rows: addenda } = await client.query<{
    id: string;
    body: string;
    author_name: string | null;
    created_at: Date;
  }>(
    `select a.id, a.body, u.name as author_name, a.created_at
     from discharge_summary_addenda a left join users u on u.id = a.author_id
     where a.admission_id = $1 order by a.created_at, a.id`,
    [admissionId],
  );
  return {
    admissionId,
    status: row.status,
    diagnoses: row.diagnoses,
    procedures: row.procedures,
    course: row.course,
    results: row.results,
    medicines: row.medicines,
    followUp: row.follow_up,
    ...(row.template_id !== null && row.template_version !== null
      ? { template: { id: row.template_id, version: row.template_version } }
      : {}),
    ...(row.signed_at ? { signedAt: row.signed_at.toISOString() } : {}),
    ...(row.signed_by_name !== null && row.status === 'signed'
      ? { signedByName: row.signed_by_name }
      : {}),
    addenda: addenda.map((each) => ({
      id: each.id,
      body: each.body,
      authorName: each.author_name ?? '',
      createdAt: each.created_at.toISOString(),
    })),
    // A signed summary's own row never changes; an addendum counts as a change of the whole.
    version: row.version + addenda.length,
  };
}

const notFound = () => new HttpError(404, 'admission_not_found', 'No such admission');
const noSummary = () => new HttpError(404, 'summary_not_found', 'No summary has been started');
const signed = () => new HttpError(409, 'summary_signed', 'A signed summary cannot be changed');
const conflict = () => new HttpError(409, 'conflict', 'Someone changed the summary first');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dischargeSummaryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of DISCHARGE_SUMMARY_SCHEMAS) app.addSchema(schema);

  async function stayOf(
    request: FastifyRequest,
    permission: Permission,
    lock: boolean,
  ): Promise<AdmissionRow> {
    const { admissionId } = request.params as { admissionId: string };
    const row = await findAdmission(
      request.txClient,
      admissionId,
      { scope: request.access.scope(permission), userId: userIdOf(request) },
      { forUpdate: lock },
    );
    if (!row) throw notFound();
    if (row.status === 'cancelled') {
      throw new HttpError(409, 'invalid_transition', 'The admission was cancelled');
    }
    return row;
  }

  const config = (permissions: Permission[]) =>
    ({
      permissions,
      feature: FEATURE,
      idempotent: { body: 'none', required: true },
    }) as const;

  const current = async (request: FastifyRequest, admissionId: string) => {
    const row = await summaryOf(request.txClient, admissionId);
    if (!row) throw noSummary();
    return view(request.txClient, admissionId, row);
  };

  app.get(
    '/admissions/:admissionId/discharge-summary',
    {
      config: { permissions: [READ, 'admission:read'], feature: FEATURE },
      schema: {
        operationId: 'getDischargeSummary',
        tags: ['admissions'],
        description:
          'The discharge summary of an admission (DS-02). 404 `summary_not_found` while none has been started. Requires dischargeSummary:read and admission:read and the admissions feature flag. Audited as a read.',
        params: AdmissionParams,
        response: { 200: ref(DischargeSummary), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await stayOf(request, READ, false);
      const answer = await current(request, row.id);
      request.audit('read', 'discharge_summary', row.id);
      return answer;
    },
  );

  app.put(
    '/admissions/:admissionId/discharge-summary',
    {
      config: config([CREATE, READ, 'admission:read']),
      schema: {
        operationId: 'saveDischargeSummary',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Starts or changes the draft; the six sections are plain text. `version` is the one the edit started from and is absent only while no draft exists. 409 `summary_signed` once signed (add an addendum instead), 409 `conflict` when `version` is behind or missing for an existing draft, 422 `unknown_template`. The Idempotency-Key header is required: a repeat changes nothing. Requires dischargeSummary:create, dischargeSummary:read and admission:read. Audited; the text is never in an event or a log.',
        params: AdmissionParams,
        body: DischargeSummarySave,
        response: { 200: ref(DischargeSummary), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const stay = await stayOf(request, CREATE, true);
      if (request.replayOf !== null) return current(request, stay.id);
      const body = request.body as Save;
      const client = request.txClient;
      const text = Object.fromEntries(SECTIONS.map((key) => [key, tidyLines(body[key])])) as Record<
        Section,
        string
      >;
      if (SECTIONS.some((key) => [...text[key]].length > SECTION_MAX)) {
        throw new HttpError(400, 'validation_failed', 'A section is too long');
      }
      if (body.template && !UUID.test(body.template.id)) {
        throw new HttpError(422, 'unknown_template', 'No such template');
      }
      const template = body.template ?? null;
      const before = await summaryOf(client, stay.id, true);
      if (before) {
        if (before.status === 'signed') throw signed();
        if (body.version !== before.version) throw conflict();
      } else if (body.version !== undefined) {
        throw conflict();
      }
      const values = SECTIONS.map((key) => text[key]);
      try {
        if (before) {
          await client.query(
            `update discharge_summaries set diagnoses = $2, procedures = $3, course = $4,
               results = $5, medicines = $6, follow_up = $7, template_id = $8,
               template_version = $9, version = version + 1, updated_by = $10
             where admission_id = $1`,
            [
              stay.id,
              ...values,
              template?.id ?? null,
              template?.version ?? null,
              userIdOf(request),
            ],
          );
        } else {
          await client.query(
            `insert into discharge_summaries (tenant_id, admission_id, diagnoses, procedures,
               course, results, medicines, follow_up, template_id, template_version,
               created_by, updated_by)
             values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
            [
              stay.id,
              ...values,
              template?.id ?? null,
              template?.version ?? null,
              userIdOf(request),
            ],
          );
        }
      } catch (error) {
        if ((error as { code?: string }).code === '23503') {
          throw new HttpError(422, 'unknown_template', 'No such template');
        }
        throw error;
      }
      request.audit(before ? 'update' : 'create', 'discharge_summary', stay.id);
      return current(request, stay.id);
    },
  );

  app.post(
    '/admissions/:admissionId/discharge-summary/sign',
    {
      config: config([SIGN, READ, 'admission:read']),
      schema: {
        operationId: 'signDischargeSummary',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Signs the draft as the caller; it can never be changed after. 404 `summary_not_found`, 409 `summary_signed`, 409 `conflict` when `version` is behind, 422 `summary_incomplete` when the diagnoses or the course are empty. The Idempotency-Key header is required. Requires dischargeSummary:sign, dischargeSummary:read and admission:read. Audited.',
        params: AdmissionParams,
        body: DischargeSummarySign,
        response: { 200: ref(DischargeSummary), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const stay = await stayOf(request, SIGN, true);
      if (request.replayOf !== null) return current(request, stay.id);
      const client = request.txClient;
      const before = await summaryOf(client, stay.id, true);
      if (!before) throw noSummary();
      if (before.status === 'signed') throw signed();
      if (before.version !== (request.body as { version: number }).version) throw conflict();
      if (before.diagnoses.trim() === '' || before.course.trim() === '') {
        throw new HttpError(422, 'summary_incomplete', 'Diagnoses and course are needed');
      }
      await client.query(
        `update discharge_summaries set status = 'signed', signed_by = $2, signed_at = now(),
           version = version + 1, updated_by = $2
         where admission_id = $1`,
        [stay.id, userIdOf(request)],
      );
      request.audit('sign', 'discharge_summary', stay.id);
      return current(request, stay.id);
    },
  );

  app.post(
    '/admissions/:admissionId/discharge-summary/addenda',
    {
      config: config([SIGN, READ, 'admission:read']),
      schema: {
        operationId: 'addDischargeSummaryAddendum',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds an addendum to a signed summary; the summary itself is not changed and an addendum is never edited. 409 `summary_not_signed` while it is a draft. The Idempotency-Key header is required: a repeat adds nothing more. Requires dischargeSummary:sign, dischargeSummary:read and admission:read. Audited.',
        params: AdmissionParams,
        body: DischargeSummaryAddendumCreate,
        response: { 200: ref(DischargeSummary), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const stay = await stayOf(request, SIGN, true);
      if (request.replayOf !== null) return current(request, stay.id);
      const client = request.txClient;
      const before = await summaryOf(client, stay.id, true);
      if (!before) throw noSummary();
      if (before.status !== 'signed') {
        throw new HttpError(409, 'summary_not_signed', 'Only a signed summary has addenda');
      }
      const text = tidyLines((request.body as { body: string }).body);
      if (text === '' || [...text].length > ADDENDUM_MAX) {
        throw new HttpError(400, 'validation_failed', 'An addendum says something, briefly');
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into discharge_summary_addenda (tenant_id, admission_id, body, author_id)
         values (app_tenant_id(), $1, $2, $3) returning id`,
        [stay.id, text, userIdOf(request)],
      );
      request.audit('create', 'discharge_summary_addendum', rows[0]?.id ?? stay.id);
      return current(request, stay.id);
    },
  );

  app.post(
    '/admissions/:admissionId/discharge-summary/print',
    {
      config: config([READ, 'admission:read']),
      schema: {
        operationId: 'recordDischargeSummaryPrint',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that the signed summary was printed (the audit log) and nothing else, once per idempotency key. 404 `summary_not_found`, 409 `summary_not_signed` for a draft. Requires dischargeSummary:read and admission:read.',
        params: AdmissionParams,
        response: {
          204: Type.Null({ description: 'Recorded' }),
          ...errors(400, 401, 403, 404, 409, 429),
        },
      },
    },
    async (request, reply) => {
      const stay = await stayOf(request, READ, false);
      const row = await summaryOf(request.txClient, stay.id);
      if (!row) throw noSummary();
      if (row.status !== 'signed') {
        throw new HttpError(409, 'summary_not_signed', 'Only a signed summary is printed');
      }
      if (request.replayOf === null) request.audit('print', 'discharge_summary', stay.id);
      return reply.status(204).send(null);
    },
  );
};
