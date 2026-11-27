import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { getStream } from '../../core/files/store.js';
import { verifyOffboardExport } from '../../core/files/signing.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { withPlatformTransaction } from '../../core/platform/db.js';
import { createExport, EXPORT_JOB, type ExportJob } from './export.js';
import { EXPORT_LINK_JOB, EXPORT_LINK_TTL_SECONDS, type ExportLinkJob } from './export-link.js';
import {
  getHospital,
  hasExportRecipient,
  mayReceiveExport,
  recordPlatformAudit,
  wouldHaveExportRecipient,
} from './repository.js';
import {
  ExportDownloadParams,
  ExportDownloadQuery,
  ExportLinkBody,
  ExportLinkSent,
  ExportParams,
  ExportRecipient,
  HospitalParams,
  PlatformExport,
  PlatformExportList,
} from './schemas.js';

interface ExportRow {
  id: string;
  hospital_id: string;
  status: PlatformExport['status'];
  failure: string | null;
  requested_at: Date;
  finished_at: Date | null;
  file_bytes: string | null;
  sha256: string | null;
  table_count: number | null;
  row_count: string | null;
  file_count: number | null;
  download_count: number;
  first_downloaded_at: Date | null;
  last_downloaded_at: Date | null;
}

const COLUMNS = `id, hospital_id, status, failure, requested_at, finished_at, file_bytes, sha256,
  table_count, row_count, file_count, download_count, first_downloaded_at, last_downloaded_at`;

const iso = (date: Date | null) => (date === null ? null : date.toISOString());
const count = (value: string | null) => (value === null ? null : Number(value));

function toExport(row: ExportRow): PlatformExport {
  return {
    id: row.id,
    hospitalId: row.hospital_id,
    status: row.status,
    failure: row.failure,
    requestedAt: row.requested_at.toISOString(),
    finishedAt: iso(row.finished_at),
    fileBytes: count(row.file_bytes),
    sha256: row.sha256,
    tableCount: row.table_count,
    rowCount: count(row.row_count),
    fileCount: row.file_count,
    downloadCount: row.download_count,
    firstDownloadedAt: iso(row.first_downloaded_at),
    lastDownloadedAt: iso(row.last_downloaded_at),
  };
}

const NOT_FOUND = () => new HttpError(404, 'export_not_found', 'No such export');

/**
 * The offboarding export of a hospital (#960, decided in #959): started with the offboarding or
 * again by the platform, listed, and handed to the hospital's admin through a signed link that
 * lasts seven days and is made for that admin. Read the platform `CLAUDE.md`.
 */
export const exportRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { pool } = app.database;
  const limit = { rateLimit: { max: app.config.RATE_LIMIT_USER_PER_MINUTE, timeWindow: 60_000 } };
  const tags = ['platform'];
  const admin = (request: { platformAdmin: { userId: string } | null }) => {
    if (!request.platformAdmin) throw new HttpError(401, 'unauthenticated', 'No session');
    return request.platformAdmin.userId;
  };

  app.post(
    '/platform/hospitals/:id/exports',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformStartHospitalExport',
        tags,
        description:
          'Makes the export of an offboarding hospital (every table, its audit log and its stored files, as one archive with a manifest and checksums). Offboarding starts one by itself; this is for another, for instance after a failed one. 409 `hospital_not_offboarding`, or `export_in_progress` while one is queued or running.',
        params: HospitalParams,
        response: { 202: ref(PlatformExport), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const userId = admin(request);
      const { id } = request.params;
      const created = await withPlatformTransaction(pool, async (client) => {
        const hospital = await getHospital(client, id);
        if (hospital.status !== 'offboarding') {
          throw new HttpError(409, 'hospital_not_offboarding', 'The hospital is not offboarding');
        }
        const exportId = await createExport(client, id, userId);
        if (!exportId) {
          throw new HttpError(409, 'export_in_progress', 'An export is already being made');
        }
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.export_requested',
          entity: 'hospital_export',
          entityId: exportId,
          hospitalId: id,
          requestId: request.id,
        });
        const { rows } = await client.query<ExportRow>(
          `select ${COLUMNS} from tenant_exports where id = $1`,
          [exportId],
        );
        return rows[0] as ExportRow;
      });
      const job: ExportJob = { exportId: created.id };
      await app.jobs
        .send(EXPORT_JOB, job, { id: `${EXPORT_JOB}:${created.id}`, retryLimit: 3, retryDelay: 60 })
        .catch(() => {
          request.log.warn({ event: 'export_job_not_queued' }, 'export job not queued');
        });
      return reply.status(202).send(toExport(created));
    },
  );

  app.get(
    '/platform/hospitals/:id/exports',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformListHospitalExports',
        tags,
        description:
          'The hospital’s exports, newest first (at most 20), with when each was made and downloaded: what the deletion checks.',
        params: HospitalParams,
        response: { 200: ref(PlatformExportList), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const { id } = request.params;
      return withPlatformTransaction(pool, async (client) => {
        await getHospital(client, id);
        const { rows } = await client.query<ExportRow>(
          `select ${COLUMNS} from tenant_exports where hospital_id = $1
           order by requested_at desc, id desc limit 20`,
          [id],
        );
        return { items: rows.map(toExport) };
      });
    },
  );

  app.get(
    '/platform/hospitals/:id/export-recipient',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformGetHospitalExportRecipient',
        tags,
        description:
          'Whether anybody at the hospital, in any status, could receive its export: an active member whose role holds both `role:manage` and `patient:read`. Read before offboarding, to warn when nobody can (the export would then wait for an operator). Offboarding is not refused.',
        params: HospitalParams,
        response: { 200: ref(ExportRecipient), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const { id } = request.params;
      return withPlatformTransaction(pool, async (client) => {
        await getHospital(client, id);
        return { hasRecipient: await wouldHaveExportRecipient(client, id) };
      });
    },
  );

  app.post(
    '/platform/hospitals/:id/exports/:exportId/email-link',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformEmailHospitalExportLink',
        tags,
        description:
          'Emails a signed download link of a made export, valid for seven days, to one active member of the hospital whose role, whatever it is called, holds both `role:manage` and `patient:read`. A job makes the link and it goes only to that admin: the operator never sees it and the response carries none. Send another during the grace period when it has expired; each download is in the platform trail under that admin. 409 `export_not_ready` until the export has succeeded, `hospital_not_offboarding`, `not_a_hospital_admin` (this person may not receive it) or `export_has_no_recipient` (nobody at the hospital may, so no id will do).',
        params: ExportParams,
        body: ExportLinkBody,
        response: { 202: ref(ExportLinkSent), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const userId = admin(request);
      const { id, exportId } = request.params;
      const { adminUserId } = request.body;
      await withPlatformTransaction(pool, async (client) => {
        const hospital = await getHospital(client, id);
        const { rows } = await client.query<{ status: string }>(
          'select status from tenant_exports where id = $1 and hospital_id = $2',
          [exportId, id],
        );
        if (!rows[0]) throw NOT_FOUND();
        if (rows[0].status !== 'succeeded') {
          throw new HttpError(409, 'export_not_ready', 'The export has not been made');
        }
        if (hospital.status !== 'offboarding') {
          throw new HttpError(409, 'hospital_not_offboarding', 'The hospital is not offboarding');
        }
        if (!(await mayReceiveExport(client, id, adminUserId))) {
          // Told apart, so a wrong id is not retried for a hospital where no id would do.
          if (!(await hasExportRecipient(client, id))) {
            throw new HttpError(
              409,
              'export_has_no_recipient',
              'Nobody at the hospital may receive the export',
            );
          }
          throw new HttpError(
            409,
            'not_a_hospital_admin',
            'This person may not receive the export',
          );
        }
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.export_link_issued',
          entity: 'hospital_export',
          entityId: exportId,
          hospitalId: id,
          detail: { adminUserId },
          requestId: request.id,
        });
      });
      const job: ExportLinkJob = { exportId, adminUserId };
      await app.jobs.send(EXPORT_LINK_JOB, job, {
        id: `${EXPORT_LINK_JOB}:${exportId}:${adminUserId}:${request.id}`,
        retryLimit: 3,
        retryDelay: 60,
      });
      return reply.status(202).send({
        adminUserId,
        expiresInDays: EXPORT_LINK_TTL_SECONDS / 86_400,
      });
    },
  );

  // The signed link is the credential, so this route has no session. Every refusal is the same
  // 404: a forged or expired link, an export that is gone, a hospital no longer offboarding, a
  // person who has since lost either permission or their active account.
  app.get(
    '/offboarding-exports/:exportId',
    {
      config: { access: 'public', rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        operationId: 'downloadOffboardingExport',
        tags,
        description:
          'The archive of an offboarded hospital’s data, for a link emailed by `platformEmailHospitalExportLink`. The signature in the query is the only credential; the download is audited under the admin the link was made for. 404 `export_not_found` for anything else.',
        params: ExportDownloadParams,
        querystring: ExportDownloadQuery,
        response: {
          200: Type.String({ description: 'The tar archive.' }),
          ...errors(400, 404, 429),
        },
      },
    },
    async (request, reply) => {
      const { exportId } = request.params;
      const { admin: adminUserId, expires, signature } = request.query;
      if (
        !verifyOffboardExport(
          app.config.REPORT_URL_SECRET,
          `${exportId}.${adminUserId}`,
          expires,
          signature,
        )
      ) {
        throw NOT_FOUND();
      }
      const found = await withPlatformTransaction(pool, async (client) => {
        const { rows } = await client.query<{ hospital_id: string; file_key: string }>(
          `select e.hospital_id, e.file_key from tenant_exports e
           join tenants t on t.id = e.hospital_id
           where e.id = $1 and e.status = 'succeeded' and e.file_key is not null
             and t.status = 'offboarding'`,
          [exportId],
        );
        const row = rows[0];
        if (!row || !(await mayReceiveExport(client, row.hospital_id, adminUserId))) return null;
        return row;
      });
      if (!found) throw NOT_FOUND();
      const file = await getStream(app.files, found.file_key);
      if (!file) throw NOT_FOUND();
      await withPlatformTransaction(pool, async (client) => {
        await client.query(
          `update tenant_exports
           set download_count = download_count + 1, last_downloaded_at = now(),
               first_downloaded_at = coalesce(first_downloaded_at, now())
           where id = $1`,
          [exportId],
        );
        await recordPlatformAudit(client, {
          actorId: adminUserId,
          action: 'hospital.export_downloaded',
          entity: 'hospital_export',
          entityId: exportId,
          hospitalId: found.hospital_id,
          requestId: request.id,
        });
      });
      return reply
        .header('content-type', 'application/x-tar')
        .header('content-disposition', `attachment; filename="hospital-export-${exportId}.tar"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file);
    },
  );
};
