import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Permission } from '../../core/access/registry.js';
import { asWorker, looksLike } from '../../core/files/worker.js';
import {
  signImageDownload,
  signImageUpload,
  verifyImageDownload,
  verifyImageUpload,
} from '../../core/files/signing.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { imagingOrder } from '../clinical/index.js';
import {
  IMAGE_MAX_BYTES,
  IMAGE_SCHEMAS,
  IMAGE_TYPES,
  IMAGES_PER_STUDY,
  ImageParams,
  ImagingImageCreate,
  ImagingImageDownload,
  ImagingImagePage,
  ImagingImageUpload,
  SignedQuery,
  UPLOAD_TTL_SECONDS,
  type ImageType,
} from './image-schemas.js';
import { studyOf, UUID } from './repository.js';
import { OrderParams } from './schemas.js';

const FEATURE = 'radiology';
const READ = 'imagingStudy:read';
const PERFORM = 'imagingStudy:perform';
export const SCAN_JOB = 'radiology.scan';

export interface ScanJob {
  imageId: string;
}

interface ImageRow {
  id: string;
  study_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: 'pending' | 'scanning' | 'clean' | 'infected' | 'failed';
  created_at: Date;
  uploaded_at: Date | null;
}

const COLUMNS =
  'id, study_id, file_name, content_type, size_bytes, status, created_at, uploaded_at';

const view = (row: ImageRow) => ({
  id: row.id,
  studyId: row.study_id,
  fileName: row.file_name,
  contentType: row.content_type,
  size: row.size_bytes,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  ...(row.uploaded_at ? { uploadedAt: row.uploaded_at.toISOString() } : {}),
});

export const fileKeyOf = (tenantId: string, imageId: string) => `imaging/${tenantId}/${imageId}`;

const orderNotFound = () => new HttpError(404, 'order_not_found', 'No such imaging order');
const imageNotFound = () => new HttpError(404, 'image_not_found', 'No such image');
const fileNotFound = () => new HttpError(404, 'image_file_not_found', 'No such file');

async function imageById(client: pg.ClientBase, id: string): Promise<ImageRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<ImageRow>(
    `select ${COLUMNS} from imaging_images where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export const imageRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of IMAGE_SCHEMAS) app.addSchema(schema);

  // The file arrives as it is, not as JSON. Only the accepted types are parsed; anything else is
  // a 415 before the body is read.
  app.addContentTypeParser(
    [...IMAGE_TYPES],
    { parseAs: 'buffer', bodyLimit: IMAGE_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  /** Only the scope `all` reaches anything, as in the rest of radiology. */
  const reaches = (request: FastifyRequest, permission: Permission) =>
    request.access.scope(permission) === 'all';

  const uploadOf = (row: ImageRow) => {
    const expires = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const signature = signImageUpload(app.config.REPORT_URL_SECRET, row.id, expires);
    return {
      image: view(row),
      uploadUrl: `/imaging-uploads/${row.id}?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  };

  app.post(
    '/radiology/orders/:orderId/images',
    {
      config: {
        permissions: [PERFORM],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'requestImagingImageUpload',
        tags: ['radiology'],
        headers: RequiredIdempotencyHeaders,
        description: `Asks to attach a file to the performed study of an imaging order (#99). Nothing is stored yet: the answer holds a signed address (valid ${UPLOAD_TTL_SECONDS / 60} minutes) to PUT the file to with the same Content-Type. The announced size must be at most ${IMAGE_MAX_BYTES} bytes (422 \`file_too_large\`) and the type one of ${IMAGE_TYPES.join(', ')} (422 \`file_type_not_allowed\`); the file received is checked against both, and against its first bytes. At most ${IMAGES_PER_STUDY} files a study (409 \`too_many_images\`); the study must be performed (409 \`invalid_transition\`). Requires imagingStudy:perform and the radiology feature flag.`,
        params: OrderParams,
        body: ref(ImagingImageCreate),
        response: { 201: ref(ImagingImageUpload), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as ImagingImageCreate;
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      if (!reaches(request, PERFORM)) throw orderNotFound();

      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await imageById(request.txClient, request.idempotentId)
          : null;
        if (!again) throw orderNotFound();
        request.audit('read', 'imaging_image', again.id);
        return reply.status(201).send(uploadOf(again));
      }

      if (!IMAGE_TYPES.includes(body.contentType as ImageType)) {
        throw new HttpError(
          422,
          'file_type_not_allowed',
          `Accepted types: ${IMAGE_TYPES.join(', ')}`,
        );
      }
      if (body.size > IMAGE_MAX_BYTES) {
        throw new HttpError(422, 'file_too_large', `A file is at most ${IMAGE_MAX_BYTES} bytes`);
      }
      const fileName = tidyWithin(body.fileName, 200);
      if (!fileName) throw new HttpError(400, 'validation_failed', 'A file needs a name');

      const order = await imagingOrder(request.txClient, request.params.orderId, {
        forUpdate: true,
      });
      if (!order) throw orderNotFound();
      const study = await studyOf(request.txClient, order.id, { forUpdate: true });
      if (!study?.performed_at) {
        throw new HttpError(409, 'invalid_transition', 'Files are attached to a performed study');
      }
      const count = await request.txClient.query<{ n: number }>(
        'select count(*)::int as n from imaging_images where study_id = $1',
        [study.id],
      );
      if ((count.rows[0]?.n ?? 0) >= IMAGES_PER_STUDY) {
        throw new HttpError(
          409,
          'too_many_images',
          `A study holds at most ${IMAGES_PER_STUDY} files`,
        );
      }
      const { rows } = await request.txClient.query<ImageRow>(
        `insert into imaging_images (tenant_id, study_id, order_id, encounter_id, patient_id,
           file_name, content_type, size_bytes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${COLUMNS}`,
        [
          study.tenant_id,
          study.id,
          study.order_id,
          study.encounter_id,
          study.patient_id,
          fileName,
          body.contentType,
          body.size,
          userId,
        ],
      );
      const row = rows[0]!;
      request.idempotentId = row.id;
      request.audit('create', 'imaging_image', row.id);
      return reply.status(201).send(uploadOf(row));
    },
  );

  app.get(
    '/radiology/orders/:orderId/images',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listImagingImages',
        tags: ['radiology'],
        description:
          'The files attached to an imaging order’s study (#99), oldest first, with the state of each. A study holds at most 50, so the page is the whole list and `nextCursor` is null. Requires imagingStudy:read with the scope `all`.',
        params: OrderParams,
        response: { 200: ref(ImagingImagePage), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      if (!reaches(request, READ)) throw orderNotFound();
      const order = await imagingOrder(request.txClient, request.params.orderId);
      if (!order) throw orderNotFound();
      const { rows } = await request.txClient.query<ImageRow>(
        `select ${COLUMNS} from imaging_images where order_id = $1 order by created_at, id`,
        [order.id],
      );
      for (const row of rows) request.audit('read', 'imaging_image', row.id);
      return { items: rows.map(view), nextCursor: null };
    },
  );

  app.get(
    '/radiology/images/:imageId/download-url',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getImagingImageDownloadUrl',
        tags: ['radiology'],
        description:
          'A signed, short-lived address for a file that passed the malware scan (`REPORT_URL_TTL_SECONDS`). The link needs no session, so give it only to the person who asked; it is audited here as an `export`. 409 `image_not_ready` until the scan has finished, 409 `image_blocked` for a file that was infected or lost. Requires imagingStudy:read with the scope `all`.',
        params: ImageParams,
        response: { 200: ref(ImagingImageDownload), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      if (!reaches(request, READ)) throw imageNotFound();
      const row = await imageById(request.txClient, request.params.imageId);
      if (!row) throw imageNotFound();
      if (row.status === 'pending' || row.status === 'scanning') {
        throw new HttpError(409, 'image_not_ready', 'The file has not been scanned yet');
      }
      if (row.status !== 'clean') {
        throw new HttpError(409, 'image_blocked', 'The file cannot be downloaded');
      }
      const expires = Math.floor(Date.now() / 1000) + app.config.REPORT_URL_TTL_SECONDS;
      const signature = signImageDownload(app.config.REPORT_URL_SECRET, row.id, expires);
      request.audit('export', 'imaging_image', row.id);
      return {
        url: `/imaging-files/${row.id}?expires=${expires}&signature=${signature}`,
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },
  );

  // The signed link is the credential: no session and no hospital, so the row is found as the
  // worker role, and every refusal of a link that is forged, expired or for nothing is one 404.
  app.put(
    '/imaging-uploads/:imageId',
    {
      config: { access: 'public', rateLimit: { max: 30, timeWindow: 60_000 } },
      bodyLimit: IMAGE_MAX_BYTES,
      schema: {
        operationId: 'uploadImagingImage',
        tags: ['radiology'],
        description:
          'The file itself, for a link made by `requestImagingImageUpload`. Send the bytes with the Content-Type announced. The signature in the query is the only credential, and the link works once: the file must be exactly the announced size (400 `size_mismatch`) and begin as its type does (415 `file_type_mismatch`). It is then held until the malware scan clears it. 404 `image_file_not_found` for any other link.',
        params: ImageParams,
        querystring: SignedQuery,
        response: { 204: Type.Null(), ...errors(400, 404, 413, 415, 429) },
      },
    },
    async (request, reply) => {
      const { imageId } = request.params;
      const { expires, signature } = request.query;
      if (!UUID.test(imageId)) throw fileNotFound();
      if (!verifyImageUpload(app.config.REPORT_URL_SECRET, imageId, expires, signature)) {
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
          `select tenant_id, content_type, size_bytes from imaging_images
           where id = $1 and status = 'pending' for update`,
          [imageId],
        );
        const row = rows[0];
        if (!row) throw fileNotFound();
        if (request.headers['content-type']?.split(';')[0]?.trim() !== row.content_type) {
          throw new HttpError(415, 'file_type_mismatch', 'The type differs from the one announced');
        }
        if (data.length !== row.size_bytes) {
          throw new HttpError(400, 'size_mismatch', 'The file is not the size announced');
        }
        if (!looksLike(row.content_type as ImageType, data)) {
          throw new HttpError(415, 'file_type_mismatch', 'The file is not of the type announced');
        }
        const key = fileKeyOf(row.tenant_id, imageId);
        await app.files.put(key, data);
        try {
          await client.query(
            `update imaging_images set status = 'scanning', file_key = $2, sha256 = $3,
               uploaded_at = now() where id = $1`,
            [imageId, key, createHash('sha256').update(data).digest('hex')],
          );
        } catch (error) {
          await app.files.delete(key).catch(() => undefined);
          throw error;
        }
      });
      await app.jobs.send(SCAN_JOB, { imageId } satisfies ScanJob, { id: `scan-${imageId}` });
      request.log.info({ event: 'imaging_image_received', imageId }, 'imaging file received');
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/imaging-files/:imageId',
    {
      config: { access: 'public', rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        operationId: 'downloadImagingImage',
        tags: ['radiology'],
        description:
          'A file that passed the malware scan, for a link made by `getImagingImageDownloadUrl`. The signature in the query is the only credential. 404 `image_file_not_found` for anything else.',
        params: ImageParams,
        querystring: SignedQuery,
        response: { 200: Type.String({ description: 'The file.' }), ...errors(400, 404, 429) },
      },
    },
    async (request, reply) => {
      const { imageId } = request.params;
      const { expires, signature } = request.query;
      if (!UUID.test(imageId)) throw fileNotFound();
      if (!verifyImageDownload(app.config.REPORT_URL_SECRET, imageId, expires, signature)) {
        throw fileNotFound();
      }
      const row = await asWorker(app, async (client) => {
        const { rows } = await client.query<{
          file_key: string;
          file_name: string;
          content_type: string;
        }>(
          `select file_key, file_name, content_type from imaging_images
           where id = $1 and status = 'clean' and file_key is not null`,
          [imageId],
        );
        return rows[0];
      });
      if (!row) throw fileNotFound();
      const file = await app.files.get(row.file_key);
      if (!file) throw fileNotFound();
      // The link has no session: this line (ids only) says that the file was taken, and when.
      request.log.info({ event: 'imaging_image_downloaded', imageId }, 'imaging file downloaded');
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
export async function scanImage(app: FastifyInstance, job: ScanJob): Promise<void> {
  const row = await asWorker(app, async (client) => {
    const { rows } = await client.query<{ file_key: string }>(
      `select file_key from imaging_images where id = $1 and status = 'scanning'`,
      [job.imageId],
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
      `update imaging_images set status = $2, scan_result = $3, scanned_at = now()
       where id = $1 and status = 'scanning'`,
      [job.imageId, status, result],
    ),
  );
  if (status === 'infected') {
    app.log.warn({ event: 'imaging_image_infected', imageId: job.imageId }, 'imaging file blocked');
  }
}
