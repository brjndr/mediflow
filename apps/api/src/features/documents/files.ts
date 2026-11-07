import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { verifyDocumentDownload, verifyDocumentUpload } from '../../core/files/signing.js';
import { asWorker, looksLike } from '../../core/files/worker.js';
import { HttpError } from '../../core/http/errors.js';
import { errors } from '../../core/http/schemas.js';
import { DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, DocumentParams, SignedQuery } from './schemas.js';

export const SCAN_JOB = 'documents.scan';
export const SWEEP_JOB = 'documents.sweep';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScanJob {
  documentId: string;
}

export const fileKeyOf = (tenantId: string, documentId: string) =>
  `documents/${tenantId}/${documentId}`;

const fileNotFound = () => new HttpError(404, 'document_file_not_found', 'No such file');

/**
 * The two public routes: the signed link is the credential, there is no session and no hospital,
 * so the row is found as the worker role, and every refusal of a link that is forged, expired or
 * for nothing is one 404.
 */
export const documentFileRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // The file arrives as it is, not as JSON. Anything but the accepted types is a 415 before the
  // body is read.
  app.addContentTypeParser(
    [...DOCUMENT_TYPES],
    { parseAs: 'buffer', bodyLimit: DOCUMENT_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.put(
    '/document-uploads/:documentId',
    {
      config: { access: 'public', rateLimit: { max: 30, timeWindow: 60_000 } },
      bodyLimit: DOCUMENT_MAX_BYTES,
      schema: {
        operationId: 'uploadPatientDocument',
        tags: ['documents'],
        description:
          'The file itself, for a link made by `requestPatientDocumentUpload`. Send the bytes with the Content-Type announced. The signature in the query is the only credential, and the link works once: the file must be exactly the announced size (400 `size_mismatch`) and begin as its type does (415 `file_type_mismatch`). It is then held until the malware scan clears it. 404 `document_file_not_found` for any other link.',
        params: DocumentParams,
        querystring: SignedQuery,
        response: { 204: Type.Null(), ...errors(400, 404, 413, 415, 429) },
      },
    },
    async (request, reply) => {
      const { documentId } = request.params;
      const { expires, signature } = request.query;
      if (!UUID.test(documentId)) throw fileNotFound();
      if (!verifyDocumentUpload(app.config.REPORT_URL_SECRET, documentId, expires, signature)) {
        throw fileNotFound();
      }
      const data: unknown = request.body;
      if (!Buffer.isBuffer(data)) {
        throw new HttpError(415, 'file_type_mismatch', 'Send the file itself');
      }
      await asWorker(app, async (client) => {
        const { rows } = await client.query<{
          tenant_id: string;
          content_type: string;
          size_bytes: number;
        }>(
          `select tenant_id, content_type, size_bytes from patient_documents
           where id = $1 and status = 'pending' for update`,
          [documentId],
        );
        const row = rows[0];
        if (!row) throw fileNotFound();
        if (request.headers['content-type']?.split(';')[0]?.trim() !== row.content_type) {
          throw new HttpError(415, 'file_type_mismatch', 'The type differs from the one announced');
        }
        if (data.length !== row.size_bytes) {
          throw new HttpError(400, 'size_mismatch', 'The file is not the size announced');
        }
        if (!looksLike(row.content_type, data)) {
          throw new HttpError(415, 'file_type_mismatch', 'The file is not of the type announced');
        }
        const key = fileKeyOf(row.tenant_id, documentId);
        await app.files.put(key, data);
        try {
          await client.query(
            `update patient_documents set status = 'scanning', file_key = $2, sha256 = $3,
               uploaded_at = now() where id = $1`,
            [documentId, key, createHash('sha256').update(data).digest('hex')],
          );
        } catch (error) {
          await app.files.delete(key).catch(() => undefined);
          throw error;
        }
      });
      await app.jobs.send(SCAN_JOB, { documentId } satisfies ScanJob, {
        id: `scan-${documentId}`,
      });
      request.log.info({ event: 'document_received', documentId }, 'document file received');
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/document-files/:documentId',
    {
      config: { access: 'public', rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        operationId: 'downloadPatientDocument',
        tags: ['documents'],
        description:
          'A file that passed the malware scan, for a link made by `getPatientDocumentDownloadUrl`. The signature in the query is the only credential. 404 `document_file_not_found` for anything else.',
        params: DocumentParams,
        querystring: SignedQuery,
        response: { 200: Type.String({ description: 'The file.' }), ...errors(400, 404, 429) },
      },
    },
    async (request, reply) => {
      const { documentId } = request.params;
      const { expires, signature } = request.query;
      if (!UUID.test(documentId)) throw fileNotFound();
      if (!verifyDocumentDownload(app.config.REPORT_URL_SECRET, documentId, expires, signature)) {
        throw fileNotFound();
      }
      const row = await asWorker(app, async (client) => {
        const { rows } = await client.query<{
          file_key: string;
          file_name: string;
          content_type: string;
        }>(
          `select file_key, file_name, content_type from patient_documents
           where id = $1 and status = 'clean' and file_key is not null`,
          [documentId],
        );
        return rows[0];
      });
      if (!row) throw fileNotFound();
      const file = await app.files.get(row.file_key);
      if (!file) throw fileNotFound();
      // The link has no session: this line (ids only) says that the file was taken, and when.
      request.log.info({ event: 'document_downloaded', documentId }, 'document file downloaded');
      const safeName = row.file_name.replace(/[^A-Za-z0-9._ -]/g, '_');
      return reply
        .header('content-type', row.content_type)
        .header('content-disposition', `attachment; filename="${safeName}"`)
        .header('x-content-type-options', 'nosniff')
        .send(file);
    },
  );
};

/**
 * The scan job: reads the received file, asks the scanner, and either releases the file for
 * download or deletes it. At-least-once delivery is safe: only a file still `scanning` is acted on.
 */
export async function scanDocument(app: FastifyInstance, job: ScanJob): Promise<void> {
  const row = await asWorker(app, async (client) => {
    const { rows } = await client.query<{ file_key: string }>(
      `select file_key from patient_documents where id = $1 and status = 'scanning'`,
      [job.documentId],
    );
    return rows[0];
  });
  if (!row) return;

  const file = await app.files.get(row.file_key);
  let status: 'clean' | 'infected' | 'failed';
  let result: string | null = null;
  if (!file) {
    status = 'failed';
    result = 'file_missing';
  } else {
    const found = await app.scanner.scan(file);
    status = found.clean ? 'clean' : 'infected';
    if (!found.clean) result = found.signature.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 100);
  }
  if (status !== 'clean') await app.files.delete(row.file_key).catch(() => undefined);
  await asWorker(app, (client) =>
    client.query(
      `update patient_documents set status = $2, scan_result = $3, scanned_at = now()
       where id = $1 and status = 'scanning'`,
      [job.documentId, status, result],
    ),
  );
  if (status === 'infected') {
    app.log.warn({ event: 'document_infected', documentId: job.documentId }, 'document blocked');
  }
}

/**
 * The retention sweep, daily at every hospital as the worker role: removes the file of each clean
 * document past its `retain_until` and marks the row `purged`, which stays as the record that the
 * document existed. Files first, then rows: a file that cannot be deleted keeps its row `clean`
 * and the next sweep tries again. Returns the keys it could not delete.
 */
export async function sweepDocuments(app: FastifyInstance): Promise<string[]> {
  const due = await asWorker(app, async (client) => {
    const { rows } = await client.query<{ id: string; file_key: string }>(
      `select id, file_key from patient_documents
       where status = 'clean' and retain_until < current_date and file_key is not null
       order by retain_until limit 500`,
    );
    return rows;
  });
  const failed: string[] = [];
  const gone: string[] = [];
  for (const document of due) {
    try {
      await app.files.delete(document.file_key);
      gone.push(document.id);
    } catch {
      failed.push(document.file_key);
    }
  }
  if (gone.length > 0) {
    await asWorker(app, (client) =>
      client.query(
        `update patient_documents set status = 'purged', purged_at = now(), file_key = null
         where id = any($1::uuid[]) and status = 'clean' and retain_until < current_date`,
        [gone],
      ),
    );
    app.log.info({ event: 'documents_purged', count: gone.length }, 'documents past retention');
  }
  return failed;
}
