import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { patientInScope } from '../patients/index.js';
import { ClaimParams } from './claim-schemas.js';
import { isCode, isUuid, userIdOf } from './util.js';

const FEATURE = 'insurance';
/** The packet holds at most this many files, as the names list always did. */
export const PACKET_FILES_MAX = 20;
/** A packet is changed only while the claim is still being put together or answered. */
const OPEN_FOR_FILES = ['draft', 'submitted', 'query'];

export const ClaimFile = Type.Object(
  {
    documentId: Type.String({ format: 'uuid' }),
    title: Type.String(),
    fileName: Type.String(),
    contentType: Type.String(),
    size: Type.Integer(),
    category: Type.String(),
    status: Type.String({ description: 'The document status; only `clean` can be downloaded.' }),
    retired: Type.Boolean(),
    attachedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'ClaimFile' },
);
export type ClaimFile = Static<typeof ClaimFile>;
export const ClaimFileList = Type.Object(
  { items: Type.Array(ref(ClaimFile), { maxItems: PACKET_FILES_MAX }) },
  { $id: 'ClaimFileList' },
);
export const ClaimFileAttach = Type.Object(
  { documentId: Type.String({ format: 'uuid' }) },
  { $id: 'ClaimFileAttach', additionalProperties: false },
);
export const ClaimFileParams = Type.Object({
  claimId: Type.String({ maxLength: 64 }),
  documentId: Type.String({ maxLength: 64 }),
});
export const CLAIM_FILE_SCHEMAS = [ClaimFile, ClaimFileList, ClaimFileAttach];

interface FileRow {
  document_id: string;
  title: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  category: string;
  status: string;
  retired_at: Date | null;
  attached_at: Date;
}

const FILES = `select cd.document_id, d.title, d.file_name, d.content_type, d.size_bytes, d.category,
    d.status, d.retired_at, cd.attached_at
  from claim_documents cd
  join patient_documents d on d.tenant_id = cd.tenant_id and d.id = cd.document_id
 where cd.claim_id = $1
 order by cd.attached_at, cd.document_id`;

const fileView = (row: FileRow): ClaimFile => ({
  documentId: row.document_id,
  title: row.title,
  fileName: row.file_name,
  contentType: row.content_type,
  size: row.size_bytes,
  category: row.category,
  status: row.status,
  retired: row.retired_at !== null,
  attachedAt: row.attached_at.toISOString(),
});

const claimGone = () => new HttpError(404, 'claim_not_found', 'No such claim');
const documentGone = () => new HttpError(404, 'document_not_found', 'No such document');
const closed = () =>
  new HttpError(409, 'claim_closed', 'The packet of this claim is no longer changed');

/**
 * The files of a claim's packet (#976): documents of the claim's patient, attached from the
 * patient's record. Needs the documents module on as well as insurance, and `document:read` for a
 * patient the caller may read. A link is all that is stored; the file is downloaded through the
 * document's own route.
 */
export const claimFileRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** The claim, after the documents switch and the patient scope are checked. */
  async function open(request: FastifyRequest, claimId: string) {
    const policy = await request.access.policy();
    if (policy?.features.documents !== true) {
      throw new HttpError(403, 'feature_disabled', 'Documents are not switched on');
    }
    const grant = policy.permissions.find((held) => held.permission === 'document:read');
    if (!grant) throw new HttpError(403, 'permission_denied', 'Documents cannot be read');
    if (!isUuid(claimId)) throw claimGone();
    const { rows } = await request.txClient.query<{
      id: string;
      patient_id: string;
      status: string;
    }>('select id, patient_id, status from claims where id = $1', [claimId]);
    const claim = rows[0];
    if (!claim) throw claimGone();
    const inScope = await patientInScope(request.txClient, claim.patient_id, {
      scope: grant.scope ?? 'all',
      userId: userIdOf(request),
    });
    if (!inScope) throw claimGone();
    return claim;
  }

  app.get(
    '/claims/:claimId/files',
    {
      config: { permissions: ['claim:read', 'document:read'], feature: FEATURE },
      schema: {
        operationId: 'listClaimFiles',
        tags: ['insurance'],
        description:
          "The files in a claim's packet, from the patient's documents. Download one with the document's own download-url. 403 `feature_disabled` when documents are off. Needs claim:read and document:read. Audited.",
        params: ClaimParams,
        response: { 200: ref(ClaimFileList), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const claim = await open(request, request.params.claimId);
      const { rows } = await request.txClient.query<FileRow>(FILES, [claim.id]);
      request.audit('read', 'claim', claim.id);
      return { items: rows.map(fileView) };
    },
  );

  app.post(
    '/claims/:claimId/files',
    {
      config: { permissions: ['claim:manage', 'document:read'], feature: FEATURE },
      schema: {
        operationId: 'attachClaimFile',
        tags: ['insurance'],
        description:
          "Puts a document of the claim's patient in the claim's packet. The document must be one that passed the malware scan (409 `document_not_ready`), not retired (409 `document_retired`) and the patient's own (404 `document_not_found`). The claim must be a draft, submitted or in query (409 `claim_closed`); the packet holds at most 20 files (422 `packet_full`); the same file twice is 409 `already_attached`. Needs claim:manage and document:read. Audited.",
        params: ClaimParams,
        body: ClaimFileAttach,
        response: { 201: ref(ClaimFileList), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const claim = await open(request, request.params.claimId);
      const client = request.txClient;
      // The claim row is locked, so two attachments cannot both pass the count.
      const { rows: locked } = await client.query<{ status: string }>(
        'select status from claims where id = $1 for update',
        [claim.id],
      );
      if (!OPEN_FOR_FILES.includes(locked[0]?.status ?? '')) throw closed();
      const { rows: docs } = await client.query<{ status: string; retired_at: Date | null }>(
        'select status, retired_at from patient_documents where id = $1 and patient_id = $2',
        [request.body.documentId, claim.patient_id],
      );
      const doc = docs[0];
      if (!doc) throw documentGone();
      if (doc.retired_at) throw new HttpError(409, 'document_retired', 'The document was retired');
      if (doc.status !== 'clean') {
        throw new HttpError(409, 'document_not_ready', 'The document has not passed the scan');
      }
      const { rows: count } = await client.query<{ n: string }>(
        'select count(*) as n from claim_documents where claim_id = $1',
        [claim.id],
      );
      if (Number(count[0]?.n ?? 0) >= PACKET_FILES_MAX) {
        throw new HttpError(422, 'packet_full', 'A packet holds at most 20 files');
      }
      // A savepoint, so a repeat is a clean 409 and the request's transaction goes on.
      await client.query('savepoint attach');
      try {
        await client.query(
          'insert into claim_documents (claim_id, document_id, attached_by) values ($1, $2, $3)',
          [claim.id, request.body.documentId, userIdOf(request)],
        );
      } catch (error) {
        if (isCode(error, '23505')) {
          await client.query('rollback to savepoint attach');
          throw new HttpError(409, 'already_attached', 'The file is already in the packet');
        }
        throw error;
      }
      request.audit('update', 'claim', claim.id, `attach:${request.body.documentId}`);
      const { rows } = await client.query<FileRow>(FILES, [claim.id]);
      return reply.code(201).send({ items: rows.map(fileView) });
    },
  );

  app.delete(
    '/claims/:claimId/files/:documentId',
    {
      config: { permissions: ['claim:manage', 'document:read'], feature: FEATURE },
      schema: {
        operationId: 'detachClaimFile',
        tags: ['insurance'],
        description:
          "Takes a file out of a claim's packet. The document stays on the patient's record. The claim must be a draft, submitted or in query (409 `claim_closed`). Needs claim:manage and document:read. Audited.",
        params: ClaimFileParams,
        response: { 200: ref(ClaimFileList), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const claim = await open(request, request.params.claimId);
      if (!OPEN_FOR_FILES.includes(claim.status)) throw closed();
      const { documentId } = request.params;
      const removed = isUuid(documentId)
        ? await request.txClient.query(
            'delete from claim_documents where claim_id = $1 and document_id = $2',
            [claim.id, documentId],
          )
        : null;
      if (!removed?.rowCount) throw documentGone();
      request.audit('update', 'claim', claim.id, `detach:${documentId}`);
      const { rows } = await request.txClient.query<FileRow>(FILES, [claim.id]);
      return { items: rows.map(fileView) };
    },
  );
};
