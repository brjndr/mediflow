import type pg from 'pg';

/**
 * Whether a file (not retired, whatever its category or uploader) or a consent is on the visit
 * (#1214, #1223). A file the scan blocked is gone, so it does not count.
 */
export async function hasFileOrConsent(
  client: pg.ClientBase,
  encounterId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from patient_documents
     where encounter_id = $1 and retired_at is null and status in ('pending', 'scanning', 'clean')
     union all
     select 1 from patient_consents where encounter_id = $1
     limit 1`,
    [encounterId],
  );
  return (rowCount ?? 0) > 0;
}
