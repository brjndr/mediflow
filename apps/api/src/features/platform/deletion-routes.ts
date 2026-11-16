import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { withPlatformTransaction } from '../../core/platform/db.js';
import {
  DELETE_JOB,
  deletionBlocker,
  type DeleteJob,
  type DeletionBasis,
  type DeletionBlocker,
} from './deletion.js';
import { getHospital, recordPlatformAudit } from './repository.js';
import { DeletionRequestBody, HospitalParams, PlatformDeletion } from './schemas.js';

interface DeletionRow {
  id: string;
  hospital_id: string;
  status: PlatformDeletion['status'];
  basis: PlatformDeletion['basis'];
  export_id: string | null;
  waiver_reference: string | null;
  requested_by: string;
  requested_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  finished_at: Date | null;
  failure: string | null;
  table_count: number | null;
  row_count: string | null;
  file_count: number | null;
}

const COLUMNS = `id, hospital_id, status, basis, export_id, waiver_reference, requested_by,
  requested_at, approved_by, approved_at, finished_at, failure, table_count, row_count, file_count`;

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

function toDeletion(row: DeletionRow): PlatformDeletion {
  return {
    id: row.id,
    hospitalId: row.hospital_id,
    status: row.status,
    basis: row.basis,
    exportId: row.export_id,
    waiverReference: row.waiver_reference,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at.toISOString(),
    approvedBy: row.approved_by,
    approvedAt: iso(row.approved_at),
    finishedAt: iso(row.finished_at),
    failure: row.failure,
    tableCount: row.table_count,
    rowCount: row.row_count === null ? null : Number(row.row_count),
    fileCount: row.file_count,
  };
}

const BLOCKED: Record<DeletionBlocker, string> = {
  hospital_not_offboarding: 'The hospital is not offboarding',
  grace_period_not_over: 'The grace period is not over',
  export_not_downloaded: 'The export was not made and downloaded',
  legal_hold: 'A legal hold is in force',
  medico_legal_open: 'A medico-legal case is still open',
};

const refuse = (blocker: DeletionBlocker) => new HttpError(409, blocker, BLOCKED[blocker]);

/**
 * Deleting an offboarded hospital's data (#961, decided in #959): one platform admin requests it,
 * a second approves, a job deletes. Reactivating the hospital cancels it (`routes.ts`). Read the
 * platform `CLAUDE.md`.
 */
export const deletionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { pool } = app.database;
  const limit = { rateLimit: { max: app.config.RATE_LIMIT_USER_PER_MINUTE, timeWindow: 60_000 } };
  const tags = ['platform'];
  const admin = (request: { platformAdmin: { userId: string } | null }) => {
    if (!request.platformAdmin) throw new HttpError(401, 'unauthenticated', 'No session');
    return request.platformAdmin.userId;
  };

  const latest = async (client: pg.ClientBase, hospitalId: string): Promise<DeletionRow | null> => {
    const { rows } = await client.query<DeletionRow>(
      `select ${COLUMNS} from tenant_deletions where hospital_id = $1
       order by requested_at desc, id limit 1`,
      [hospitalId],
    );
    return rows[0] ?? null;
  };

  app.get(
    '/platform/hospitals/:id/deletion',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformGetHospitalDeletion',
        tags,
        description:
          'The latest request to delete the hospital’s data, whatever its status. 404 `no_deletion` when there has been none.',
        params: HospitalParams,
        response: { 200: ref(PlatformDeletion), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      admin(request);
      const row = await withPlatformTransaction(pool, (client) =>
        latest(client, request.params.id),
      );
      if (!row) throw new HttpError(404, 'no_deletion', 'No deletion has been requested');
      return toDeletion(row);
    },
  );

  app.post(
    '/platform/hospitals/:id/deletion',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformRequestHospitalDeletion',
        tags,
        description:
          'Asks for the hospital’s data to be deleted for good. Needs the grace period over (409 `grace_period_not_over`), an export that was made and downloaded or a waiver reference (409 `export_not_downloaded`), and no legal hold (409 `legal_hold`) or open medico-legal case (409 `medico_legal_open`). Nothing is deleted until a second platform admin approves. 409 `deletion_in_progress` while one is open.',
        params: HospitalParams,
        body: DeletionRequestBody,
        response: { 202: ref(PlatformDeletion), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const userId = admin(request);
      const { id } = request.params;
      const waiver = request.body.waiverReference?.trim() || null;
      const exportId = await withPlatformTransaction(pool, async (client) => {
        await getHospital(client, id);
        if (waiver !== null) return null;
        const { rows } = await client.query<{ id: string }>(
          `select id from tenant_exports
           where hospital_id = $1 and status = 'succeeded' and first_downloaded_at is not null
           order by finished_at desc limit 1`,
          [id],
        );
        return rows[0]?.id ?? null;
      });
      const basis: DeletionBasis = { exportId, waiverReference: waiver };
      if (exportId === null && waiver === null) {
        // Whatever else stops it comes first; with nothing else, it is the missing export.
        throw refuse((await deletionBlocker(pool, id, basis)) ?? 'export_not_downloaded');
      }
      const blocker = await deletionBlocker(pool, id, basis);
      if (blocker) throw refuse(blocker);
      const row = await withPlatformTransaction(pool, async (client) => {
        let inserted: DeletionRow | undefined;
        try {
          const result = await client.query<DeletionRow>(
            `insert into tenant_deletions (hospital_id, requested_by, basis, export_id, waiver_reference)
             values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
            [id, userId, exportId ? 'export' : 'waiver', exportId, waiver],
          );
          inserted = result.rows[0];
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new HttpError(409, 'deletion_in_progress', 'A deletion is already open');
          }
          throw error;
        }
        const created = inserted as DeletionRow;
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.deletion_requested',
          entity: 'hospital_deletion',
          entityId: created.id,
          hospitalId: id,
          detail: { basis: created.basis },
          requestId: request.id,
        });
        return created;
      });
      return reply.code(202).send(toDeletion(row));
    },
  );

  app.post(
    '/platform/hospitals/:id/deletion/approve',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformApproveHospitalDeletion',
        tags,
        description:
          'A second platform admin approves the request; the deletion job is queued. 409 `approver_must_differ` for the one who asked, `no_deletion_awaiting_approval`, or any reason `platformRequestHospitalDeletion` gives, checked again now.',
        params: HospitalParams,
        response: { 202: ref(PlatformDeletion), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const userId = admin(request);
      const { id } = request.params;
      const open = await withPlatformTransaction(pool, (client) => latest(client, id));
      if (!open) throw new HttpError(404, 'no_deletion', 'No deletion has been requested');
      if (open.status !== 'requested') {
        throw new HttpError(
          409,
          'no_deletion_awaiting_approval',
          'There is no request waiting for approval',
        );
      }
      if (open.requested_by === userId) {
        throw new HttpError(409, 'approver_must_differ', 'A second platform admin must approve');
      }
      const blocker = await deletionBlocker(pool, id, {
        exportId: open.export_id,
        waiverReference: open.waiver_reference,
      });
      if (blocker) throw refuse(blocker);
      const row = await withPlatformTransaction(pool, async (client) => {
        const { rows } = await client.query<DeletionRow>(
          `update tenant_deletions set status = 'approved', approved_by = $2, approved_at = now()
           where id = $1 and status = 'requested' returning ${COLUMNS}`,
          [open.id, userId],
        );
        const approved = rows[0];
        if (!approved) {
          throw new HttpError(
            409,
            'no_deletion_awaiting_approval',
            'There is no request waiting for approval',
          );
        }
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.deletion_approved',
          entity: 'hospital_deletion',
          entityId: approved.id,
          hospitalId: id,
          detail: { requestedBy: approved.requested_by },
          requestId: request.id,
        });
        return approved;
      });
      const job: DeleteJob = { deletionId: row.id };
      await app.jobs
        .send(DELETE_JOB, job, { id: `${DELETE_JOB}:${row.id}`, retryLimit: 3, retryDelay: 60 })
        .catch(() => {
          request.log.warn({ event: 'deletion_job_not_queued' }, 'deletion job not queued');
        });
      return reply.code(202).send(toDeletion(row));
    },
  );

  app.post(
    '/platform/hospitals/:id/deletion/cancel',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformCancelHospitalDeletion',
        tags,
        description:
          'Withdraws a request that has not started (requested or approved). 409 `no_open_deletion`, or `deletion_running` once the job has started.',
        params: HospitalParams,
        response: { 200: ref(PlatformDeletion), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const userId = admin(request);
      const { id } = request.params;
      return withPlatformTransaction(pool, async (client) => {
        const { rows } = await client.query<DeletionRow>(
          `update tenant_deletions set status = 'cancelled', cancelled_at = now()
           where hospital_id = $1 and status in ('requested', 'approved') returning ${COLUMNS}`,
          [id],
        );
        const cancelled = rows[0];
        if (!cancelled) {
          const current = await latest(client, id);
          if (current?.status === 'running') {
            throw new HttpError(409, 'deletion_running', 'The deletion has started');
          }
          if (!current) throw new HttpError(404, 'no_deletion', 'No deletion has been requested');
          throw new HttpError(409, 'no_open_deletion', 'There is no open request');
        }
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.deletion_cancelled',
          entity: 'hospital_deletion',
          entityId: cancelled.id,
          hospitalId: id,
          detail: { reason: 'withdrawn' },
          requestId: request.id,
        });
        return toDeletion(cancelled);
      });
    },
  );
};
