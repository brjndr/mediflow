import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Permission } from '../../core/access/registry.js';
import { signDocumentDownload, signDocumentUpload } from '../../core/files/signing.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { patientInScope, patientMergedInto } from '../patients/index.js';
import {
  CategoryParams,
  HoldListQuery,
  HoldParams,
  LegalHold,
  LegalHoldCreate,
  LegalHoldPage,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_SCHEMAS,
  DOCUMENT_TYPES,
  DocumentListQuery,
  DocumentParams,
  PatientDocument,
  PatientDocumentCreate,
  PatientDocumentDownload,
  PatientDocumentPage,
  PatientDocumentRetire,
  PatientDocumentUpload,
  PatientParams,
  RetentionRuleSet,
  RetentionRules,
  UPLOAD_TTL_SECONDS,
  DOCUMENT_CATEGORIES,
  type DocumentType,
} from './schemas.js';

const FEATURE = 'documents';
const READ = 'document:read';
const UPLOAD = 'document:upload';
const RETIRE = 'document:retire';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentRow {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  category: string;
  title: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  retain_until: string | null;
  retired_at: Date | null;
  retired_reason: string | null;
  held: boolean;
  version: number;
  created_at: Date;
}

export const COLUMNS = `id, patient_id, encounter_id, category, title, file_name, content_type,
  size_bytes, status, retain_until::text as retain_until, retired_at, retired_reason, version,
  created_at,
  exists (select 1 from document_legal_holds h
    where h.tenant_id = patient_documents.tenant_id and h.released_at is null
      and (h.document_id = patient_documents.id
        or (h.document_id is null and h.patient_id = patient_documents.patient_id))) as held`;

export const view = (row: DocumentRow) => ({
  id: row.id,
  patientId: row.patient_id,
  ...(row.encounter_id ? { encounterId: row.encounter_id } : {}),
  category: row.category as (typeof DOCUMENT_CATEGORIES)[number],
  title: row.title,
  fileName: row.file_name,
  contentType: row.content_type,
  size: row.size_bytes,
  status: row.status as PatientDocument['status'],
  ...(row.retain_until ? { retainUntil: row.retain_until } : {}),
  ...(row.retired_at ? { retiredAt: row.retired_at.toISOString() } : {}),
  ...(row.retired_reason ? { retiredReason: row.retired_reason } : {}),
  held: row.held,
  version: row.version,
  createdAt: row.created_at.toISOString(),
});

const patientNotFound = () => new HttpError(404, 'not_found', 'No such patient');
const documentNotFound = () => new HttpError(404, 'document_not_found', 'No such document');

const encodeCursor = (row: DocumentRow) =>
  Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString('base64url');
function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || Number.isNaN(Date.parse(at)) || !id || !UUID.test(id)) {
    throw new HttpError(400, 'invalid_cursor', 'The cursor does not belong to this list');
  }
  return { at, id };
}

export const documentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of DOCUMENT_SCHEMAS) app.addSchema(schema);

  const userIdOf = (request: FastifyRequest): string => {
    const userId = request.session?.userId;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
    return userId;
  };

  /** The patient must be one the caller's scope for `permission` reaches: else the same 404. */
  async function reachable(request: FastifyRequest, patientId: string, permission: Permission) {
    const inScope = await patientInScope(request.txClient, patientId, {
      scope: request.access.scope(permission),
      userId: userIdOf(request),
    });
    if (!inScope) throw patientNotFound();
  }

  /** A document found through its patient's scope, so a narrower role cannot guess an id. */
  async function documentOf(request: FastifyRequest, id: string, permission: Permission) {
    if (!UUID.test(id)) throw documentNotFound();
    const { rows } = await request.txClient.query<DocumentRow>(
      `select ${COLUMNS} from patient_documents where id = $1 for update`,
      [id],
    );
    const row = rows[0];
    if (!row) throw documentNotFound();
    try {
      await reachable(request, row.patient_id, permission);
    } catch {
      throw documentNotFound();
    }
    return row;
  }

  const uploadOf = (row: DocumentRow) => {
    const expires = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const signature = signDocumentUpload(app.config.REPORT_URL_SECRET, row.id, expires);
    return {
      document: view(row),
      uploadUrl: `/document-uploads/${row.id}?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  };

  app.post(
    '/patients/:patientId/documents',
    {
      config: {
        permissions: [UPLOAD],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'requestPatientDocumentUpload',
        tags: ['documents'],
        headers: RequiredIdempotencyHeaders,
        description: `Asks to attach a file to a patient's record (#194). Nothing is stored yet: the answer holds a signed address (valid ${UPLOAD_TTL_SECONDS / 60} minutes) to PUT the file to with the same Content-Type. At most ${DOCUMENT_MAX_BYTES} bytes (422 \`file_too_large\`); one of ${DOCUMENT_TYPES.join(', ')} (422 \`file_type_not_allowed\`); the file received is checked against both and against its first bytes, then held until the malware scan clears it. \`encounterId\`, when sent, must be an encounter of this patient (422 \`encounter_mismatch\`). 409 \`patient_merged\` for a record that was merged into another. The retention date comes from the category's rule at the time of the request. Requires document:upload and the documents feature flag.`,
        params: PatientParams,
        body: ref(PatientDocumentCreate),
        response: { 201: ref(PatientDocumentUpload), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as PatientDocumentCreate;
      const userId = userIdOf(request);
      await reachable(request, request.params.patientId, UPLOAD);

      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await request.txClient.query<DocumentRow>(
              `select ${COLUMNS} from patient_documents where id = $1`,
              [request.idempotentId],
            )
          : null;
        const row = again?.rows[0];
        if (!row) throw patientNotFound();
        request.audit('read', 'patient_document', row.id);
        return reply.status(201).send(uploadOf(row));
      }

      if (!DOCUMENT_TYPES.includes(body.contentType as DocumentType)) {
        throw new HttpError(
          422,
          'file_type_not_allowed',
          `Accepted types: ${DOCUMENT_TYPES.join(', ')}`,
        );
      }
      if (body.size > DOCUMENT_MAX_BYTES) {
        throw new HttpError(422, 'file_too_large', `A file is at most ${DOCUMENT_MAX_BYTES} bytes`);
      }
      const fileName = tidyWithin(body.fileName, 200);
      const title = tidyWithin(body.title, 200);
      if (!fileName || !title) throw new HttpError(400, 'validation_failed', 'Name the document');

      if ((await patientMergedInto(request.txClient, request.params.patientId)) !== null) {
        throw new HttpError(409, 'patient_merged', 'This record was merged into another');
      }
      if (body.encounterId) {
        const { rowCount } = await request.txClient.query(
          'select 1 from encounters where id = $1 and patient_id = $2',
          [body.encounterId, request.params.patientId],
        );
        if (rowCount !== 1) {
          throw new HttpError(422, 'encounter_mismatch', 'The encounter is not this patient’s');
        }
      }
      const { rows } = await request.txClient.query<DocumentRow>(
        `insert into patient_documents (tenant_id, patient_id, encounter_id, category, title,
           file_name, content_type, size_bytes, created_by, retain_until)
         select app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8,
           (select (now() at time zone t.timezone)::date + make_interval(years => r.years::int)
            from document_retention_rules r, tenants t
            where r.category = $3 and t.id = app_tenant_id())
         returning ${COLUMNS}`,
        [
          request.params.patientId,
          body.encounterId ?? null,
          body.category,
          title,
          fileName,
          body.contentType,
          body.size,
          userId,
        ],
      );
      const row = rows[0]!;
      request.idempotentId = row.id;
      request.audit('create', 'patient_document', row.id);
      return reply.status(201).send(uploadOf(row));
    },
  );

  app.get(
    '/patients/:patientId/documents',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listPatientDocuments',
        tags: ['documents'],
        description:
          'The documents kept on a patient’s record (#194), newest first, one cursor page at a time. `encounterId` narrows them to those of one visit. Retired documents are left out unless `includeRetired` is true. Requires document:read, within the scope the role holds it with.',
        params: PatientParams,
        querystring: DocumentListQuery,
        response: { 200: ref(PatientDocumentPage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      await reachable(request, request.params.patientId, READ);
      const { cursor, limit, category, encounterId, includeRetired } = request.query;
      const params: unknown[] = [request.params.patientId];
      const where = ['patient_id = $1'];
      if (category) {
        params.push(category);
        where.push(`category = $${params.length}`);
      }
      if (encounterId) {
        params.push(encounterId);
        where.push(`encounter_id = $${params.length}`);
      }
      if (!includeRetired) where.push('retired_at is null');
      if (cursor) {
        const at = decodeCursor(cursor);
        params.push(at.at, at.id);
        where.push(
          `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      params.push(limit + 1);
      const { rows } = await request.txClient.query<DocumentRow>(
        `select ${COLUMNS} from patient_documents where ${where.join(' and ')}
         order by created_at desc, id desc limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'patient_document', row.id);
      const last = page[page.length - 1];
      return {
        items: page.map(view),
        nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },
  );

  app.get(
    '/documents/:documentId/download-url',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getPatientDocumentDownloadUrl',
        tags: ['documents'],
        description:
          'A signed, short-lived address for a document that passed the malware scan (`REPORT_URL_TTL_SECONDS`). The link needs no session, so give it only to the person who asked; it is audited here as an `export`. 409 `document_not_ready` until the scan has finished, 409 `document_blocked` for a file that was infected, lost or removed after its retention. A retired document can still be downloaded. Requires document:read.',
        params: DocumentParams,
        response: { 200: ref(PatientDocumentDownload), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await documentOf(request, request.params.documentId, READ);
      if (row.status === 'pending' || row.status === 'scanning') {
        throw new HttpError(409, 'document_not_ready', 'The file has not been scanned yet');
      }
      if (row.status !== 'clean') {
        throw new HttpError(409, 'document_blocked', 'The file cannot be downloaded');
      }
      const expires = Math.floor(Date.now() / 1000) + app.config.REPORT_URL_TTL_SECONDS;
      const signature = signDocumentDownload(app.config.REPORT_URL_SECRET, row.id, expires);
      request.audit('export', 'patient_document', row.id);
      return {
        url: `/document-files/${row.id}?expires=${expires}&signature=${signature}`,
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },
  );

  app.post(
    '/documents/:documentId/retire',
    {
      config: { permissions: [RETIRE, READ], feature: FEATURE },
      schema: {
        operationId: 'retirePatientDocument',
        tags: ['documents'],
        description:
          'Retires a document with a reason: it stays on the record, kept for its retention, and leaves the default list. Nothing deletes a document. At the version read: 409 `conflict`; 409 `already_retired`. Requires document:retire and document:read.',
        params: DocumentParams,
        body: ref(PatientDocumentRetire),
        response: { 200: ref(PatientDocument), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as PatientDocumentRetire;
      const row = await documentOf(request, request.params.documentId, RETIRE);
      if (row.retired_at) throw new HttpError(409, 'already_retired', 'Already retired');
      if (row.version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The document has changed since it was read');
      }
      const reason = tidyWithin(body.reason, 300);
      if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is needed');
      const { rows } = await request.txClient.query<DocumentRow>(
        `update patient_documents set retired_at = now(), retired_by = $2, retired_reason = $3
         where id = $1 returning ${COLUMNS}`,
        [row.id, userIdOf(request), reason],
      );
      request.audit('update', 'patient_document', row.id);
      return view(rows[0]!);
    },
  );

  // Retention rules: the years each category is kept. A category with no rule is kept for ever.
  app.get(
    '/document-retention',
    {
      config: { permissions: ['documentRetention:read'], feature: FEATURE },
      schema: {
        operationId: 'listDocumentRetention',
        tags: ['documents'],
        description:
          'How long the hospital keeps the documents of each category (#194): every category, with `years` null where it is kept for ever. Requires documentRetention:read.',
        response: { 200: ref(RetentionRules), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      const { rows } = await request.txClient.query<{ category: string; years: number }>(
        'select category, years from document_retention_rules',
      );
      const years = new Map(rows.map((row) => [row.category, row.years]));
      return {
        items: DOCUMENT_CATEGORIES.map((category) => ({
          category,
          years: years.get(category) ?? null,
        })),
      };
    },
  );

  app.put(
    '/document-retention/:category',
    {
      config: { permissions: ['documentRetention:manage'], feature: FEATURE },
      schema: {
        operationId: 'setDocumentRetention',
        tags: ['documents'],
        description:
          'Sets the years a category is kept, or null to keep it for ever. It applies to documents attached from now on; a document already kept keeps the date it was given, so a rule never shortens the life of an earlier document. Requires documentRetention:manage.',
        params: CategoryParams,
        body: ref(RetentionRuleSet),
        response: {
          200: Type.Object({
            category: Type.String(),
            years: Type.Union([Type.Integer(), Type.Null()]),
          }),
          ...errors(400, 401, 403, 429),
        },
      },
    },
    async (request) => {
      const { years } = request.body as RetentionRuleSet;
      const { category } = request.params;
      const client: pg.PoolClient = request.txClient;
      if (years === null) {
        await client.query('delete from document_retention_rules where category = $1', [category]);
      } else {
        await client.query(
          `insert into document_retention_rules (tenant_id, category, years, updated_by)
           values (app_tenant_id(), $1, $2, $3)
           on conflict (tenant_id, category)
           do update set years = excluded.years, updated_by = excluded.updated_by, updated_at = now()`,
          [category, years, userIdOf(request)],
        );
      }
      request.audit('update', 'document_retention', String(category));
      return { category, years };
    },
  );

  // Legal holds: while one is active the retention sweep leaves the document(s) alone.
  interface HoldRow {
    id: string;
    patient_id: string;
    document_id: string | null;
    reason: string;
    placed_at: Date;
    released_at: Date | null;
  }
  const HOLD_COLUMNS = 'id, patient_id, document_id, reason, placed_at, released_at';
  const holdView = (row: HoldRow) => ({
    id: row.id,
    patientId: row.patient_id,
    ...(row.document_id ? { documentId: row.document_id } : {}),
    reason: row.reason,
    placedAt: row.placed_at.toISOString(),
    ...(row.released_at ? { releasedAt: row.released_at.toISOString() } : {}),
  });

  async function placeHold(
    request: FastifyRequest,
    patientId: string,
    documentId: string | null,
    reasonText: string,
  ) {
    const reason = tidyWithin(reasonText, 300);
    if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is needed');
    // Lock the documents first, so a sweep working on one waits for the hold or sees it.
    await request.txClient.query(
      `select id from patient_documents
       where patient_id = $1 and ($2::uuid is null or id = $2) for update`,
      [patientId, documentId],
    );
    const { rows } = await request.txClient.query<HoldRow>(
      `insert into document_legal_holds (tenant_id, patient_id, document_id, reason, placed_by)
       values (app_tenant_id(), $1, $2, $3, $4) returning ${HOLD_COLUMNS}`,
      [patientId, documentId, reason, userIdOf(request)],
    );
    request.audit('create', 'document_legal_hold', rows[0]!.id);
    return holdView(rows[0]!);
  }

  app.post(
    '/patients/:patientId/legal-hold',
    {
      config: { permissions: ['documentRetention:manage'], feature: FEATURE },
      schema: {
        operationId: 'placePatientLegalHold',
        tags: ['documents'],
        description:
          'Holds every document of a patient (those added later too) out of the retention sweep until the hold is released. Requires documentRetention:manage.',
        params: PatientParams,
        body: ref(LegalHoldCreate),
        response: { 201: ref(LegalHold), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      await reachable(request, request.params.patientId, 'documentRetention:manage');
      reply.code(201);
      return placeHold(
        request,
        request.params.patientId,
        null,
        (request.body as LegalHoldCreate).reason,
      );
    },
  );

  app.post(
    '/documents/:documentId/legal-hold',
    {
      config: { permissions: ['documentRetention:manage'], feature: FEATURE },
      schema: {
        operationId: 'placeDocumentLegalHold',
        tags: ['documents'],
        description:
          'Holds one document out of the retention sweep until the hold is released. Requires documentRetention:manage.',
        params: DocumentParams,
        body: ref(LegalHoldCreate),
        response: { 201: ref(LegalHold), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const row = await documentOf(request, request.params.documentId, 'documentRetention:manage');
      reply.code(201);
      return placeHold(request, row.patient_id, row.id, (request.body as LegalHoldCreate).reason);
    },
  );

  app.get(
    '/legal-holds',
    {
      config: { permissions: ['documentRetention:read'], feature: FEATURE },
      schema: {
        operationId: 'listDocumentLegalHolds',
        tags: ['documents'],
        description:
          'The active legal holds of the hospital, newest first. Requires documentRetention:read.',
        querystring: HoldListQuery,
        response: { 200: ref(LegalHoldPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const { cursor, limit } = request.query as { cursor?: string; limit: number };
      const params: unknown[] = [];
      let after = '';
      if (cursor) {
        const at = decodeCursor(cursor);
        params.push(at.at, at.id);
        after = 'and (placed_at, id) < ($1::timestamptz, $2::uuid)';
      }
      params.push(limit + 1);
      const { rows } = await request.txClient.query<HoldRow>(
        `select ${HOLD_COLUMNS} from document_legal_holds where released_at is null ${after}
         order by placed_at desc, id desc limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(holdView),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(`${last.placed_at.toISOString()}|${last.id}`).toString('base64url')
            : null,
      };
    },
  );

  app.post(
    '/legal-holds/:holdId/release',
    {
      config: { permissions: ['documentRetention:manage'], feature: FEATURE },
      schema: {
        operationId: 'releaseDocumentLegalHold',
        tags: ['documents'],
        description:
          'Releases a hold; the sweep may purge what it covered once its retention is past. 404 `hold_not_found`; 409 `already_released`. Requires documentRetention:manage.',
        params: HoldParams,
        response: { 200: ref(LegalHold), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { rows } = await request.txClient.query<HoldRow>(
        `select ${HOLD_COLUMNS} from document_legal_holds where id = $1 for update`,
        [request.params.holdId],
      );
      const hold = rows[0];
      if (!hold) throw new HttpError(404, 'hold_not_found', 'No such hold');
      if (hold.released_at) throw new HttpError(409, 'already_released', 'Already released');
      const done = await request.txClient.query<HoldRow>(
        `update document_legal_holds set released_at = now(), released_by = $2 where id = $1
         returning ${HOLD_COLUMNS}`,
        [hold.id, userIdOf(request)],
      );
      request.audit('update', 'document_legal_hold', hold.id);
      return holdView(done.rows[0]!);
    },
  );
};
