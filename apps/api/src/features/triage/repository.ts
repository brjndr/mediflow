import type pg from 'pg';
import type { Allergy, Measure, Ranged } from './schemas.js';

/**
 * The triage SQL. Every statement runs on the request's own transaction under the app role, so
 * row-level security limits it to the active hospital.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VitalsRow {
  id: string;
  tenant_id: string;
  patient_id: string;
  queue_token_id: string | null;
  encounter_id: string | null;
  recorded_at: Date;
  recorded_by: string;
  recorded_by_name: string;
  systolic: number | null;
  diastolic: number | null;
  pulse: number | null;
  temperature: number | null;
  spo2: number | null;
  weight: number | null;
  height: number | null;
  chief_complaint: string | null;
  corrects_id: string | null;
  correction_reason: string | null;
}

// Decimals as numbers: the driver gives `numeric` as text.
const VITALS = `select v.id, v.tenant_id, v.patient_id, v.queue_token_id, v.encounter_id,
                       v.recorded_at, v.recorded_by, coalesce(u.name, '') as recorded_by_name,
                       v.systolic, v.diastolic, v.pulse, v.temperature::float8 as temperature,
                       v.spo2, v.weight::float8 as weight, v.height::float8 as height,
                       v.chief_complaint, v.corrects_id, v.correction_reason
                from vitals v
                left join users u on u.id = v.recorded_by`;

// The cursor's time in UTC to the microsecond, whatever the session's DateStyle.
const VITALS_WITH_CURSOR = VITALS.replace(
  'from vitals v',
  `, to_char(v.recorded_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as cursor_at
   from vitals v`,
);

interface Cursor {
  r: string;
  i: string;
}

// A timestamp as Postgres writes one, so a cursor keeps its microseconds.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { r, i } = value as Record<string, unknown>;
    if (typeof r !== 'string' || !PG_TIMESTAMP.test(r)) return null;
    if (typeof i !== 'string' || !UUID.test(i)) return null;
    return { r, i };
  } catch {
    return null;
  }
}

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/** A patient's readings, newest first, optionally of one token. Null for a bad cursor. */
export async function listVitals(
  client: pg.ClientBase,
  patientId: string,
  filters: { queueTokenId?: string; cursor?: string; limit: number },
): Promise<Page<VitalsRow> | null> {
  const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
  if (after === null) return null;
  if (filters.queueTokenId !== undefined && !UUID.test(filters.queueTokenId)) {
    return { rows: [], nextCursor: null, ...(after === undefined ? { total: 0 } : {}) };
  }
  const where = `where v.patient_id = $1 and ($2::uuid is null or v.queue_token_id = $2)`;
  const values = [patientId, filters.queueTokenId ?? null];
  const { rows } = await client.query<VitalsRow & { cursor_at: string }>(
    `${VITALS_WITH_CURSOR}
     ${where}
       and ($3::timestamptz is null or (v.recorded_at, v.id) < ($3::timestamptz, $4::uuid))
     order by v.recorded_at desc, v.id desc
     limit $5`,
    [...values, after?.r ?? null, after?.i ?? null, filters.limit + 1],
  );
  const page = rows.slice(0, filters.limit);
  const last = page.at(-1);
  const result: Page<VitalsRow> = {
    rows: page,
    nextCursor:
      rows.length > filters.limit && last
        ? Buffer.from(JSON.stringify({ r: last.cursor_at, i: last.id } satisfies Cursor)).toString(
            'base64url',
          )
        : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from vitals v ${where}`,
      values,
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** One reading of the patient, or null. */
export async function findVitals(
  client: pg.ClientBase,
  patientId: string,
  id: string,
): Promise<VitalsRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<VitalsRow>(
    `${VITALS} where v.id = $1 and v.patient_id = $2`,
    [id, patientId],
  );
  return rows[0] ?? null;
}

export interface NewReading {
  patientId: string;
  queueTokenId: string | null;
  encounterId: string | null;
  measures: Partial<Record<Measure, number>>;
  chiefComplaint: string | null;
  correctsId: string | null;
  correctionReason: string | null;
}

export async function insertVitals(
  client: pg.ClientBase,
  reading: NewReading,
  userId: string,
): Promise<string> {
  const m = reading.measures;
  const { rows } = await client.query<{ id: string }>(
    `insert into vitals (tenant_id, patient_id, queue_token_id, encounter_id, recorded_by,
       systolic, diastolic, pulse, temperature, spo2, weight, height,
       chief_complaint, corrects_id, correction_reason)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      reading.patientId,
      reading.queueTokenId,
      reading.encounterId,
      userId,
      m.systolic ?? null,
      m.diastolic ?? null,
      m.pulse ?? null,
      m.temperature ?? null,
      m.spo2 ?? null,
      m.weight ?? null,
      m.height ?? null,
      reading.chiefComplaint,
      reading.correctsId,
      reading.correctionReason,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('reading was not recorded');
  return id;
}

/** The built-in adult ranges, for a hospital that has set none of its own. */
export const DEFAULT_RANGES: Record<Ranged, { low?: number; high?: number }> = {
  systolic: { low: 90, high: 139 },
  diastolic: { low: 60, high: 89 },
  pulse: { low: 60, high: 100 },
  temperature: { low: 36.1, high: 37.8 },
  spo2: { low: 95 },
};

/** Whether the patient is 18 or over on today's date at the hospital, or null when unknown. */
export async function isAdult(client: pg.ClientBase, patientId: string): Promise<boolean | null> {
  if (!UUID.test(patientId)) return null;
  const { rows } = await client.query<{ adult: boolean }>(
    `select p.dob + interval '18 years' <= (now() at time zone h.timezone)::date as adult
     from patients p join tenants h on h.id = p.tenant_id
     where p.id = $1`,
    [patientId],
  );
  return rows[0]?.adult ?? null;
}

/** The hospital's own ranges, or the built-in ones when it has none. */
export async function hospitalRanges(
  client: pg.ClientBase,
): Promise<Partial<Record<Ranged, { low?: number; high?: number }>>> {
  const { rows } = await client.query<{ measure: Ranged; low: number | null; high: number | null }>(
    'select measure, low::float8 as low, high::float8 as high from vital_ranges order by measure',
  );
  if (rows.length === 0) return DEFAULT_RANGES;
  return Object.fromEntries(
    rows.map((row) => [
      row.measure,
      {
        ...(row.low === null ? {} : { low: row.low }),
        ...(row.high === null ? {} : { high: row.high }),
      },
    ]),
  );
}

export interface AllergyRow {
  patient_id: string;
  tenant_id: string;
  status: 'none' | 'listed';
  items: Allergy[];
  version: number;
  updated_at: Date;
  updated_by_name: string | null;
}

export async function findAllergies(
  client: pg.ClientBase,
  patientId: string,
): Promise<AllergyRow | null> {
  const { rows } = await client.query<AllergyRow>(
    `select a.patient_id, a.tenant_id, a.status, a.items, a.version, a.updated_at,
            u.name as updated_by_name
     from allergy_lists a left join users u on u.id = a.updated_by
     where a.patient_id = $1`,
    [patientId],
  );
  return rows[0] ?? null;
}

/**
 * Replaces the patient's allergies from the version the edit started from: 0 creates the list,
 * any other replaces it at that version. False, changing nothing, when someone else's change came
 * first (the row lock or the primary key decides between two at once). Each version is also kept
 * in `allergy_list_versions`, which nothing changes or removes.
 */
export async function replaceAllergies(
  client: pg.ClientBase,
  patientId: string,
  version: number,
  list: { status: 'none' | 'listed'; items: Allergy[] },
  userId: string,
): Promise<boolean> {
  const items = JSON.stringify(list.items);
  if (version === 0) {
    const { rowCount } = await client.query(
      `insert into allergy_lists (tenant_id, patient_id, status, items, updated_by)
       values (app_tenant_id(), $1, $2, $3::jsonb, $4)
       on conflict (tenant_id, patient_id) do nothing`,
      [patientId, list.status, items, userId],
    );
    if (rowCount !== 1) return false;
  } else {
    const { rowCount } = await client.query(
      `update allergy_lists set status = $3, items = $4::jsonb, updated_by = $5
       where patient_id = $1 and version = $2`,
      [patientId, version, list.status, items, userId],
    );
    if (rowCount !== 1) return false;
  }
  // The list as it now is, kept for good: what was removed, when and by whom stays known.
  await client.query(
    `insert into allergy_list_versions (tenant_id, patient_id, version, status, items, updated_at, updated_by)
     select tenant_id, patient_id, version, status, items, updated_at, updated_by
     from allergy_lists where patient_id = $1`,
    [patientId],
  );
  return true;
}
