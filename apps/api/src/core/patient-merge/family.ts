import type pg from 'pg';

/**
 * A patient's own id and the ids of the records merged into it (#557), so a history read shows
 * what was merged. Clinical rows stay on the record they were written for; a read filters with
 * `patient_id = any($n::uuid[])`. An id that is not a patient gives just itself.
 */
export async function patientFamily(client: pg.ClientBase, patientId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    'select source_patient_id as id from patient_merges where target_patient_id = $1',
    [patientId],
  );
  return [patientId, ...rows.map((row) => row.id)];
}

/**
 * The record a patient was merged into, following the chain to the end (#865); the patient's own
 * id when it was never merged away. A record written for the merged-away id (an old prescription)
 * is read through its survivor, so the survivor's later findings are not missed.
 */
export async function survivorOf(client: pg.ClientBase, patientId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `with recursive chain (id, depth) as (
       select $1::uuid, 0
       union all
       select p.merged_into_id, c.depth + 1
       from chain c join patients p on p.id = c.id
       where p.merged_into_id is not null and c.depth < 20
     )
     select id from chain order by depth desc limit 1`,
    [patientId],
  );
  return rows[0]?.id ?? patientId;
}
