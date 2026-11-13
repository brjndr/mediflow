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
