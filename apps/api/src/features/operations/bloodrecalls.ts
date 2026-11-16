import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import {
  BloodRecall,
  BloodRecallFollowUp,
  BloodRecallListQuery,
  BloodRecallPage,
  BloodRecallParams,
} from './schemas.js';
import { iso, userIdOf } from './util.js';

const FEATURE = 'bloodbank';
const MANAGE = 'bloodUnit:manage';

interface RecallRow {
  id: string;
  blood_unit_id: string;
  donor_id: string;
  patient_id: string | null;
  unit_status: BloodRecall['unitStatus'];
  trigger_unit_id: string;
  reason: string;
  flagged_by: string;
  flagged_at: Date;
  followed_up_by: string | null;
  followed_up_at: Date | null;
  follow_up_note: string | null;
}

const COLUMNS = `x.id, x.blood_unit_id, x.donor_id, x.patient_id, x.unit_status, x.trigger_unit_id,
       x.reason, x.flagged_by, x.flagged_at, x.followed_up_by, x.followed_up_at, x.follow_up_note`;
const SELECT = `select ${COLUMNS} from blood_unit_recalls x`;

const view = (row: RecallRow): BloodRecall => ({
  id: row.id,
  unitId: row.blood_unit_id,
  donorId: row.donor_id,
  ...(row.patient_id === null ? {} : { patientId: row.patient_id }),
  unitStatus: row.unit_status,
  triggerUnitId: row.trigger_unit_id,
  reason: row.reason,
  flaggedBy: row.flagged_by,
  flaggedAt: iso(row.flagged_at),
  ...(row.followed_up_by === null ? {} : { followedUpBy: row.followed_up_by }),
  ...(row.followed_up_at === null ? {} : { followedUpAt: iso(row.followed_up_at) }),
  ...(row.follow_up_note === null ? {} : { followUpNote: row.follow_up_note }),
});

export const bloodRecallRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/blood/recalls',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'listBloodRecalls',
        tags: ['bloodbank'],
        description:
          'Units already issued or transfused whose donor’s screening later turned reactive, newest first; `open=true` leaves out those followed up. Each names the recipient by patient id only. Cursor paging. Audited as a read. Requires bloodUnit:manage.',
        querystring: BloodRecallListQuery,
        response: { 200: ref(BloodRecallPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const query = request.query;
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.open === true) where.push('x.followed_up_at is null');
      if (query.donorId !== undefined) {
        if (!isUuid(query.donorId)) return { items: [], nextCursor: null };
        params.push(query.donorId);
        where.push(`x.donor_id = $${params.length}`);
      }
      const page = await selectPage<RecallRow>(request.txClient, {
        select: SELECT,
        where,
        params,
        order: 'x.flagged_at',
        desc: true,
        cursor: query.cursor,
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      for (const row of page.rows) request.audit('read', 'blood_unit_recall', row.id);
      return { items: page.rows.map(view), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/blood/recalls/:recallId/follow-up',
    {
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'followUpBloodRecall',
        tags: ['bloodbank'],
        headers: IdempotencyHeaders,
        description:
          'Records that the bank followed a recall up with the recipient’s doctor, once (409 `already_followed_up`); the note says what was done. 404 `blood_recall_not_found`. Audited. Requires bloodUnit:manage.',
        params: BloodRecallParams,
        body: BloodRecallFollowUp,
        response: { 200: ref(BloodRecall), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { recallId } = request.params;
      const missing = new HttpError(404, 'blood_recall_not_found', 'No such recall');
      if (!isUuid(recallId)) throw missing;
      const client = request.txClient;
      const { rows } = await client.query<RecallRow>(`${SELECT} where x.id = $1 for update`, [
        recallId,
      ]);
      const row = rows[0];
      if (!row) throw missing;
      if (row.followed_up_at !== null) {
        throw new HttpError(409, 'already_followed_up', 'The recall has been followed up');
      }
      const { rows: done } = await client.query<RecallRow>(
        `update blood_unit_recalls x set followed_up_by = $2, followed_up_at = now(), follow_up_note = $3
         where x.id = $1 returning ${COLUMNS}`,
        [recallId, userIdOf(request), request.body.note],
      );
      request.audit('update', 'blood_unit_recall', recallId);
      return view(done[0] as RecallRow);
    },
  );
};
