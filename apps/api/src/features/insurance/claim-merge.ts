import type { FastifyInstance } from 'fastify';

/** Claims still being put together or answered; a decided one stays on the record it was made for. */
const MOVABLE = ['draft', 'submitted', 'query'];

/**
 * A patient merge and the claims (#1044). Draft, submitted and in-query claims move to the
 * surviving record with the merge (their packet documents move with the record already), and the
 * ids are kept in `claim_merge_moves` so an unmerge gives back those and no claim made since.
 * Claims already decided stay where they were and are found from the survivor through the merge
 * (`GET /claims?patientId=`). A database guard lets a claim change patient only for a merge.
 */
export function registerClaimMerge(app: FastifyInstance): void {
  app.patientMerge.register(
    'claims',
    async (client, { sourceId, targetId }) => {
      const moved = await client.query<{ id: string }>(
        `update claims set patient_id = $2 where patient_id = $1 and status = any($3::text[])
         returning id`,
        [sourceId, targetId, MOVABLE],
      );
      if (moved.rows.length > 0) {
        await client.query(
          `insert into claim_merge_moves (claim_id, from_patient_id, to_patient_id)
           select unnest($1::uuid[]), $2, $3`,
          [moved.rows.map((row) => row.id), sourceId, targetId],
        );
      }
      return moved.rows.length;
    },
    async (client, { sourceId }) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*) as n from claims where patient_id = $1 and status = any($2::text[])',
        [sourceId, MOVABLE],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async (client, { sourceId, targetId }) => {
      const open = await client.query<{ claim_id: string }>(
        `select claim_id from claim_merge_moves
          where from_patient_id = $1 and to_patient_id = $2 and undone_at is null`,
        [sourceId, targetId],
      );
      const ids = open.rows.map((row) => row.claim_id);
      if (ids.length === 0) return 0;
      await client.query(
        'update claims set patient_id = $1 where id = any($2::uuid[]) and patient_id = $3',
        [sourceId, ids, targetId],
      );
      await client.query(
        `update claim_merge_moves set undone_at = now()
          where claim_id = any($3::uuid[]) and from_patient_id = $1 and to_patient_id = $2
            and undone_at is null`,
        [sourceId, targetId, ids],
      );
      return ids.length;
    },
  );
}
