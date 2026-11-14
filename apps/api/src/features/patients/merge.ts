import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { PLAIN_TEXT, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';

/**
 * Merging two records of one person (#194). The survivor is in the path, the record merged away
 * in the body. Nothing is deleted or rewritten: the source keeps its MRN and history but points at
 * the survivor for good (a database guard refuses to change that), is left out of search, and
 * cannot be changed. Every module that keeps rows for a patient registers what it moves with
 * `app.patientMerge`; all of it happens in the request's transaction, so a merge is whole or not
 * at all. Admin only by default (`patient:merge`).
 */

const FEATURE = 'patients';
const MERGE = 'patient:merge';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Id = Type.String({ format: 'uuid' });

const PatientMerge = Type.Object(
  {
    id: Type.String(),
    sourcePatientId: Type.String({ description: 'The record merged away.' }),
    targetPatientId: Type.String({ description: 'The record that stays.' }),
    reason: Type.String(),
    moved: Type.Record(Type.String(), Type.Integer(), {
      description: 'How many rows each module moved to the survivor, by module.',
    }),
    mergedBy: Type.String(),
    mergedAt: Type.String({ format: 'date-time' }),
    unmergedBy: Type.Optional(
      Type.String({ description: 'Present when the merge was undone (#555).' }),
    ),
    unmergedAt: Type.Optional(Type.String({ format: 'date-time' })),
    unmergeReason: Type.Optional(Type.String()),
    sourceName: Type.Optional(
      Type.String({
        description: 'Name of the record merged away; on the merge list only (#877).',
      }),
    ),
    sourceMrn: Type.Optional(Type.String()),
    targetName: Type.Optional(
      Type.String({ description: 'Name of the record that stays; on the merge list only (#877).' }),
    ),
    targetMrn: Type.Optional(Type.String()),
  },
  { $id: 'PatientMerge' },
);

const PatientMergeCreate = Type.Object(
  {
    sourcePatientId: Id,
    reason: Type.String({ minLength: 1, maxLength: 500, pattern: PLAIN_TEXT }),
    expectedVersion: Type.Integer({
      minimum: 1,
      description:
        'The version of the surviving record that was read (409 `conflict` if it moved).',
    }),
    expectedSourceVersion: Type.Integer({
      minimum: 1,
      description: 'The version of the record being merged away that was read.',
    }),
  },
  { $id: 'PatientMergeCreate', additionalProperties: false },
);
type PatientMergeCreate = Static<typeof PatientMergeCreate>;

const PatientUnmerge = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500, pattern: PLAIN_TEXT }) },
  { $id: 'PatientUnmerge', additionalProperties: false },
);
type PatientUnmerge = Static<typeof PatientUnmerge>;

const PatientSettings = Type.Object(
  {
    unmergeWindowDays: Type.Integer({
      minimum: 0,
      maximum: 365,
      description: 'Days after a merge during which it may be undone; 0 turns unmerging off.',
    }),
  },
  { $id: 'PatientSettings', additionalProperties: false },
);
type PatientSettings = Static<typeof PatientSettings>;
const DEFAULT_WINDOW_DAYS = 30;
const UNMERGE = 'patient:unmerge';

const PatientMergeList = Type.Object(
  { items: Type.Array(ref(PatientMerge)), nextCursor: Type.Null() },
  { $id: 'PatientMergeList' },
);

const PatientMergePreview = Type.Object(
  {
    sourcePatientId: Type.String(),
    targetPatientId: Type.String(),
    sourceVersion: Type.Integer(),
    targetVersion: Type.Integer(),
    moves: Type.Record(Type.String(), Type.Integer(), {
      description: 'How many rows each module would move to the survivor, by module; none is zero.',
    }),
  },
  { $id: 'PatientMergePreview' },
);

const PreviewQuery = Type.Object({ source: Id });

const Params = Type.Object({ patientId: Id });

interface MergeRow {
  id: string;
  source_patient_id: string;
  target_patient_id: string;
  reason: string;
  moved: Record<string, number>;
  merged_by: string;
  merged_at: Date;
  unmerged_by: string | null;
  unmerged_at: Date | null;
  unmerge_reason: string | null;
}
const COLUMNS = `id, source_patient_id, target_patient_id, reason, moved, merged_by, merged_at,
  unmerged_by, unmerged_at, unmerge_reason`;
const view = (row: MergeRow) => ({
  id: row.id,
  sourcePatientId: row.source_patient_id,
  targetPatientId: row.target_patient_id,
  reason: row.reason,
  moved: row.moved,
  mergedBy: row.merged_by,
  mergedAt: row.merged_at.toISOString(),
  ...(row.unmerged_at
    ? {
        unmergedBy: row.unmerged_by!,
        unmergedAt: row.unmerged_at.toISOString(),
        unmergeReason: row.unmerge_reason!,
      }
    : {}),
});

/** The record a patient was merged into, or null when it was not (or does not exist). */
export async function patientMergedInto(
  client: pg.ClientBase,
  patientId: string,
): Promise<string | null> {
  if (!UUID.test(patientId)) return null;
  const { rows } = await client.query<{ merged_into_id: string | null }>(
    'select merged_into_id from patients where id = $1',
    [patientId],
  );
  return rows[0]?.merged_into_id ?? null;
}

const notFound = () => new HttpError(404, 'not_found', 'No such patient');

export const mergeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addSchema(PatientMerge);
  app.addSchema(PatientMergeCreate);
  app.addSchema(PatientMergeList);
  app.addSchema(PatientUnmerge);
  app.addSchema(PatientSettings);
  app.addSchema(PatientMergePreview);

  app.get(
    '/patients/:patientId/merge-preview',
    {
      config: { permissions: [MERGE], feature: FEATURE },
      schema: {
        operationId: 'previewPatientMerge',
        tags: ['patients'],
        description:
          'What merging the record in `source` into the one in the path would move (#603): the rows each module would move, by module, and the versions of both records. Reads only, changes nothing. 404 `not_found` for a record that does not exist or is in another hospital; 409 `patient_merged` if either was merged already; 422 `same_patient`. Requires patient:merge with the scope `all`.',
        params: Params,
        querystring: PreviewQuery,
        response: { 200: ref(PatientMergePreview), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      if (request.access.scope(MERGE) !== 'all') throw notFound();
      const targetId = request.params.patientId;
      const sourceId = request.query.source;
      if (sourceId === targetId) {
        throw new HttpError(422, 'same_patient', 'A record cannot be merged into itself');
      }
      const client = request.txClient;
      const { rows } = await client.query<{
        id: string;
        version: number;
        merged_into_id: string | null;
      }>('select id, version, merged_into_id from patients where id = any($1::uuid[])', [
        [sourceId, targetId],
      ]);
      const source = rows.find((row) => row.id === sourceId);
      const target = rows.find((row) => row.id === targetId);
      if (!source || !target) throw notFound();
      if (source.merged_into_id || target.merged_into_id) {
        throw new HttpError(
          409,
          'patient_merged',
          'A record that was merged cannot be merged again',
        );
      }
      const moves = await app.patientMerge.preview(client, { sourceId, targetId });
      request.audit('read', 'patient', sourceId);
      request.audit('read', 'patient', targetId);
      return {
        sourcePatientId: sourceId,
        targetPatientId: targetId,
        sourceVersion: source.version,
        targetVersion: target.version,
        moves,
      };
    },
  );

  app.post(
    '/patients/:patientId/merge',
    {
      config: {
        permissions: [MERGE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'mergePatients',
        tags: ['patients'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Merges the record named in the body into the one in the path, which stays (#194). Atomic: the source record is marked as merged, every module moves its own rows for the patient (documents now) and the merge is recorded, all in one transaction, or none of it. Both versions must be the ones read (409 `conflict`); 409 `patient_merged` if either was merged already; 422 `same_patient`. The source keeps its MRN, leaves search and can no longer be changed. Audited, and announced as `patient.merged`. Requires patient:merge with the scope `all`.',
        params: Params,
        body: ref(PatientMergeCreate),
        response: { 201: ref(PatientMerge), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as PatientMergeCreate;
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      if (request.access.scope(MERGE) !== 'all') throw notFound();
      const client = request.txClient;

      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await client.query<MergeRow>(`select ${COLUMNS} from patient_merges where id = $1`, [
              request.idempotentId,
            ])
          : null;
        const row = again?.rows[0];
        if (!row) throw notFound();
        request.audit('read', 'patient_merge', row.id);
        return reply.status(201).send(view(row));
      }

      const targetId = request.params.patientId;
      const sourceId = body.sourcePatientId;
      if (sourceId === targetId) {
        throw new HttpError(422, 'same_patient', 'A record cannot be merged into itself');
      }
      // Both rows are locked in one order, so two merges at once cannot wait on each other.
      const locked = await client.query<{
        id: string;
        version: number;
        merged_into_id: string | null;
      }>(
        'select id, version, merged_into_id from patients where id = any($1::uuid[]) order by id for update',
        [[sourceId, targetId]],
      );
      const source = locked.rows.find((row) => row.id === sourceId);
      const target = locked.rows.find((row) => row.id === targetId);
      if (!source || !target) throw notFound();
      if (source.merged_into_id || target.merged_into_id) {
        throw new HttpError(
          409,
          'patient_merged',
          'A record that was merged cannot be merged again',
        );
      }
      if (
        source.version !== body.expectedSourceVersion ||
        target.version !== body.expectedVersion
      ) {
        throw new HttpError(409, 'conflict', 'A record has changed since it was read');
      }
      const reason = tidyWithin(body.reason, 500);
      if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is needed');

      await client.query('update patients set merged_into_id = $2 where id = $1', [
        sourceId,
        targetId,
      ]);
      const moved = await app.patientMerge.run(client, { sourceId, targetId });
      const { rows } = await client.query<MergeRow>(
        `insert into patient_merges (tenant_id, source_patient_id, target_patient_id, reason, moved,
           merged_by)
         values (app_tenant_id(), $1, $2, $3, $4::jsonb, $5) returning ${COLUMNS}`,
        [sourceId, targetId, reason, JSON.stringify(moved), userId],
      );
      const row = rows[0]!;
      request.idempotentId = row.id;
      request.audit('update', 'patient', sourceId);
      request.audit('update', 'patient', targetId);
      request.audit('create', 'patient_merge', row.id);
      await request.emit('patient.merged', targetId, {
        mergeId: row.id,
        sourcePatientId: sourceId,
        targetPatientId: targetId,
      });
      return reply.status(201).send(view(row));
    },
  );

  app.get(
    '/patients/:patientId/merges',
    {
      config: { permissions: [MERGE], feature: FEATURE },
      schema: {
        operationId: 'listPatientMerges',
        tags: ['patients'],
        description:
          'The records merged into this one (#194), newest first, at most 100 (a record is rarely merged into more than a few, so there is no next page). Requires patient:merge with the scope `all`.',
        params: Params,
        response: { 200: ref(PatientMergeList), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      if (request.access.scope(MERGE) !== 'all') throw notFound();
      const exists = await request.txClient.query('select 1 from patients where id = $1', [
        request.params.patientId,
      ]);
      if (exists.rowCount !== 1) throw notFound();
      const { rows } = await request.txClient.query<MergeRow>(
        `select ${COLUMNS} from patient_merges where target_patient_id = $1
         order by merged_at desc, id desc limit 100`,
        [request.params.patientId],
      );
      for (const row of rows) request.audit('read', 'patient_merge', row.id);
      // The names come from the same hospital's patients (RLS), under the same read and audit.
      const ids = [...new Set(rows.flatMap((r) => [r.source_patient_id, r.target_patient_id]))];
      const people = new Map<string, { name: string; mrn: string }>();
      if (ids.length > 0) {
        const found = await request.txClient.query<{ id: string; name: string; mrn: string }>(
          `select id, first_name || ' ' || last_name as name, mrn from patients where id = any($1::uuid[])`,
          [ids],
        );
        for (const p of found.rows) people.set(p.id, p);
      }
      return {
        items: rows.map((row) => {
          const source = people.get(row.source_patient_id);
          const target = people.get(row.target_patient_id);
          return {
            ...view(row),
            ...(source ? { sourceName: source.name, sourceMrn: source.mrn } : {}),
            ...(target ? { targetName: target.name, targetMrn: target.mrn } : {}),
          };
        }),
        nextCursor: null,
      };
    },
  );

  app.post(
    '/patients/:patientId/unmerge',
    {
      config: {
        permissions: [UNMERGE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'unmergePatient',
        tags: ['patients'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Undoes the merge of the record in the path (the one that was merged away) while the hospital window is open (#555; `unmergeWindowDays`, 30 by default). Atomic: the record points at nobody again and is searchable and editable, each module gives back the rows it moved at merge time (documents now), and the merge is kept with who undid it and why. 409 `not_merged` for a record that is not merged; 409 `patient_merged` when the survivor was itself merged away since; 409 `unmerge_window_closed`; 409 `unmerge_unsupported` if a module moved rows and cannot give them back. Rows written for the survivor after the merge stay with it. Audited, and announced as `patient.unmerged`. Requires patient:unmerge with the scope `all`.',
        params: Params,
        body: ref(PatientUnmerge),
        response: { 200: ref(PatientMerge), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as PatientUnmerge;
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      if (request.access.scope(UNMERGE) !== 'all') throw notFound();
      const client = request.txClient;

      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await client.query<MergeRow>(`select ${COLUMNS} from patient_merges where id = $1`, [
              request.idempotentId,
            ])
          : null;
        const row = again?.rows[0];
        if (!row) throw notFound();
        request.audit('read', 'patient_merge', row.id);
        return view(row);
      }

      const sourceId = request.params.patientId;
      const found = await client.query<{ merged_into_id: string | null }>(
        'select merged_into_id from patients where id = $1 for update',
        [sourceId],
      );
      if (found.rowCount !== 1) throw notFound();
      const targetId = found.rows[0]!.merged_into_id;
      if (!targetId) throw new HttpError(409, 'not_merged', 'This record was not merged');
      const target = await client.query<{ merged_into_id: string | null }>(
        'select merged_into_id from patients where id = $1 for update',
        [targetId],
      );
      if (target.rows[0]?.merged_into_id) {
        throw new HttpError(
          409,
          'patient_merged',
          'The record this one was merged into was merged away since',
        );
      }
      const merge = await client.query<MergeRow & { open: boolean }>(
        `select ${COLUMNS},
                merged_at + make_interval(days => coalesce(
                  (select unmerge_window_days from patient_settings), $2)) >= now() as open
           from patient_merges
          where source_patient_id = $1 and unmerged_at is null for update`,
        [sourceId, DEFAULT_WINDOW_DAYS],
      );
      const current = merge.rows[0];
      if (!current) throw notFound();
      if (!current.open) {
        throw new HttpError(409, 'unmerge_window_closed', 'The window to undo this merge is over');
      }
      const names = Object.keys(current.moved);
      if (app.patientMerge.cannotUndo(names).length > 0) {
        throw new HttpError(409, 'unmerge_unsupported', 'This merge cannot be undone');
      }
      const reason = tidyWithin(body.reason, 500);
      if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is needed');

      // The merge is marked first: the database lets the record and its rows go back only in the
      // transaction that did so.
      const { rows } = await client.query<MergeRow>(
        `update patient_merges set unmerged_at = now(), unmerged_by = $2, unmerge_reason = $3
          where id = $1 returning ${COLUMNS}`,
        [current.id, userId, reason],
      );
      await client.query('update patients set merged_into_id = null where id = $1', [sourceId]);
      await app.patientMerge.undo(client, { sourceId, targetId }, names);
      const row = rows[0]!;
      request.idempotentId = row.id;
      request.audit('update', 'patient', sourceId);
      request.audit('update', 'patient', targetId);
      request.audit('update', 'patient_merge', row.id);
      await request.emit('patient.unmerged', targetId, {
        mergeId: row.id,
        sourcePatientId: sourceId,
        targetPatientId: targetId,
      });
      return view(row);
    },
  );

  const windowOf = async (client: FastifyRequest['txClient']): Promise<PatientSettings> => {
    const { rows } = await client.query<{ unmerge_window_days: number }>(
      'select unmerge_window_days from patient_settings',
    );
    return { unmergeWindowDays: rows[0]?.unmerge_window_days ?? DEFAULT_WINDOW_DAYS };
  };

  app.get(
    '/patient-settings',
    {
      config: { permissions: [UNMERGE], feature: FEATURE },
      schema: {
        operationId: 'getPatientSettings',
        tags: ['patients'],
        description:
          'The hospital settings for patient records (#555): how many days a merge may be undone. Requires patient:unmerge.',
        response: { 200: ref(PatientSettings), ...errors(401, 403, 429) },
      },
    },
    async (request) => windowOf(request.txClient),
  );

  app.put(
    '/patient-settings',
    {
      config: { permissions: [UNMERGE], feature: FEATURE },
      schema: {
        operationId: 'setPatientSettings',
        tags: ['patients'],
        description:
          'Sets how many days after a merge it may be undone (0 turns unmerging off, at most 365). Merges already made use the new value. Audited. Requires patient:unmerge.',
        body: ref(PatientSettings),
        response: { 200: ref(PatientSettings), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      const body = request.body as PatientSettings;
      await request.txClient.query(
        `insert into patient_settings (tenant_id, unmerge_window_days, updated_by)
         values (app_tenant_id(), $1, $2)
         on conflict (tenant_id) do update set unmerge_window_days = excluded.unmerge_window_days,
           updated_by = excluded.updated_by, updated_at = now()`,
        [body.unmergeWindowDays, userId],
      );
      request.audit('update', 'patient_settings');
      return windowOf(request.txClient);
    },
  );
};
