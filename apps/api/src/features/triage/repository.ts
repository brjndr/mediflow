import type pg from 'pg';
import { BANDS, RANGED, type Allergy, type Measure, type Ranged } from './schemas.js';
import { patientFamily } from '../../core/patient-merge/family.js';
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
  const where = `where v.patient_id = any($1::uuid[]) and ($2::uuid is null or v.queue_token_id = $2)`;
  const values = [await patientFamily(client, patientId), filters.queueTokenId ?? null];
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

export type Band = (typeof BANDS)[number];
export type Limits = { low?: number; high?: number };
export type RangeSet = Partial<Record<Ranged, Limits>>;
export type RangeTable = Record<Band, RangeSet>;

/** The age, in whole years, a band starts at: under 1, 1 to 11, 12 to 17, 18 and over. */
export const BAND_STARTS: Record<Band, number> = { infant: 0, child: 1, adolescent: 12, adult: 18 };

/**
 * The built-in ranges, for a band a hospital has set none for. A starting point to be reviewed by
 * the hospital's own clinicians, not a clinical standard.
 */
export const DEFAULT_RANGES: RangeTable = {
  infant: {
    systolic: { low: 70, high: 100 },
    diastolic: { low: 40, high: 65 },
    pulse: { low: 100, high: 160 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
  child: {
    systolic: { low: 80, high: 120 },
    diastolic: { low: 50, high: 80 },
    pulse: { low: 70, high: 130 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
  adolescent: {
    systolic: { low: 90, high: 130 },
    diastolic: { low: 55, high: 85 },
    pulse: { low: 60, high: 105 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
  adult: {
    systolic: { low: 90, high: 139 },
    diastolic: { low: 60, high: 89 },
    pulse: { low: 60, high: 100 },
    temperature: { low: 36.1, high: 37.8 },
    spo2: { low: 95 },
  },
};

/** The band of a person born on `dob` on `onDate`, both as `YYYY-MM-DD` (a calendar date). */
export function bandOf(dob: string, onDate: string): Band {
  const [by = 0, bm = 0, bd = 0] = dob.split('-').map(Number);
  const [oy = 0, om = 0, od = 0] = onDate.split('-').map(Number);
  let years = oy - by;
  if (om < bm || (om === bm && od < bd)) years -= 1;
  if (years >= BAND_STARTS.adult) return 'adult';
  if (years >= BAND_STARTS.adolescent) return 'adolescent';
  if (years >= BAND_STARTS.child) return 'child';
  return 'infant';
}

/** The calendar date at a moment on the hospital's clock, as `YYYY-MM-DD`. */
export function dateAt(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(moment);
}

/** A moment after every row: the ranges as they stand, whatever the clocks say. */
export const LATEST = new Date(8.64e15);

export interface RangeRow {
  band: Band;
  measure: Ranged;
  low: number | null;
  high: number | null;
  effective_from: Date;
}

/** Every range row of the hospital. Small: twenty rows for each time the ranges were saved. */
export async function loadRangeRows(client: pg.ClientBase): Promise<RangeRow[]> {
  const { rows } = await client.query<RangeRow>(
    `select band, measure, low::float8 as low, high::float8 as high, effective_from
     from vital_ranges order by effective_from desc`,
  );
  return rows;
}

/**
 * The ranges of a band that applied at a moment: for each measure the newest row not after it,
 * else the built-in one. A row with no limits means the measure was not checked.
 */
export function rangesAt(rows: RangeRow[], band: Band, at: Date): RangeSet {
  const set: RangeSet = {};
  for (const measure of RANGED) {
    const row = rows.find(
      (r) => r.band === band && r.measure === measure && r.effective_from <= at,
    );
    const limits: Limits | undefined = row
      ? {
          ...(row.low === null ? {} : { low: row.low }),
          ...(row.high === null ? {} : { high: row.high }),
        }
      : DEFAULT_RANGES[band][measure];
    if (limits && (limits.low !== undefined || limits.high !== undefined)) set[measure] = limits;
  }
  return set;
}

/** All four bands as they apply at a moment. */
export function tableAt(rows: RangeRow[], at: Date): RangeTable {
  return Object.fromEntries(BANDS.map((band) => [band, rangesAt(rows, band, at)])) as RangeTable;
}

/** The number a hospital's ranges are at: one for each time they were saved. */
export async function rangesVersion(client: pg.ClientBase): Promise<number> {
  const { rows } = await client.query<{ version: number }>(
    'select count(distinct effective_from)::int as version from vital_ranges',
  );
  return rows[0]?.version ?? 0;
}

/**
 * The patient's date of birth and the hospital's time zone, or null for a patient the hospital
 * does not have.
 */
export async function ageBasis(
  client: pg.ClientBase,
  patientId: string,
): Promise<{ dob: string; timeZone: string } | null> {
  if (!UUID.test(patientId)) return null;
  const { rows } = await client.query<{ dob: string; timezone: string }>(
    `select p.dob::text as dob, h.timezone
     from patients p join tenants h on h.id = p.tenant_id
     where p.id = $1`,
    [patientId],
  );
  const row = rows[0];
  return row ? { dob: row.dob, timeZone: row.timezone } : null;
}

export type Flags = Partial<Record<Ranged, 'low' | 'high'>>;

/** Which values of a reading were outside the ranges in effect when it was recorded. */
export function flagsFor(
  basis: { dob: string; timeZone: string },
  rows: RangeRow[],
  reading: Pick<VitalsRow, 'recorded_at' | Ranged>,
): Flags {
  const band = bandOf(basis.dob, dateAt(reading.recorded_at, basis.timeZone));
  const set = rangesAt(rows, band, reading.recorded_at);
  const flags: Flags = {};
  for (const measure of RANGED) {
    const value = reading[measure];
    const limits = set[measure];
    if (value === null || !limits) continue;
    if (limits.low !== undefined && value < limits.low) flags[measure] = 'low';
    else if (limits.high !== undefined && value > limits.high) flags[measure] = 'high';
  }
  return flags;
}

/**
 * Saves a table of ranges as the ones in effect from now on, when the caller read the table at
 * `version`. Returns false when someone saved first. Saves are serialised per hospital.
 */
export async function saveRanges(
  client: pg.ClientBase,
  userId: string,
  table: RangeTable,
  version: number,
): Promise<boolean> {
  await client.query(
    `select pg_advisory_xact_lock(hashtextextended('vital_ranges:' || app_tenant_id()::text, 0))`,
  );
  if ((await rangesVersion(client)) !== version) return false;
  const { rows } = await client.query<{ at: Date }>('select clock_timestamp() as at');
  const at = rows[0]?.at ?? new Date();
  for (const band of BANDS) {
    for (const measure of RANGED) {
      const limits = table[band][measure];
      await client.query(
        `insert into vital_ranges (tenant_id, band, measure, low, high, effective_from, created_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6)`,
        [band, measure, limits?.low ?? null, limits?.high ?? null, at, userId],
      );
    }
  }
  return true;
}

export interface CatalogAllergen {
  id: string;
  name: string;
  name_lower: string;
  kind: 'drug_class' | 'food' | 'other';
  members: string[];
}

/** An entry of the allergen catalog, or null. The catalog is shared by every hospital. */
export async function findAllergen(
  client: pg.ClientBase,
  id: string,
): Promise<CatalogAllergen | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<CatalogAllergen>(
    `select id, name, name_lower, kind, members from allergens where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * Catalog entries in name order (then id), every word of `words` in the name. `after` continues a
 * page from a row of the catalog (name and id) or from a medicine's name, which sorts after a
 * catalog entry of the same name.
 */
export async function searchCatalog(
  client: pg.ClientBase,
  {
    words,
    kind,
    after,
    limit,
  }: {
    words: string[];
    kind?: CatalogAllergen['kind'];
    after?: { name: string; id: string; fromCatalog: boolean };
    limit: number;
  },
): Promise<CatalogAllergen[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  for (const word of words) {
    params.push(likePattern(word));
    where.push(`name_lower like lower($${params.length})`);
  }
  if (kind) {
    params.push(kind);
    where.push(`kind = $${params.length}`);
  }
  if (after) {
    params.push(after.name);
    const name = params.length;
    if (after.fromCatalog) {
      params.push(after.id);
      where.push(`(name_lower COLLATE "C", id) > ($${name}, $${params.length}::uuid)`);
    } else {
      where.push(`name_lower COLLATE "C" > $${name}`);
    }
  }
  params.push(limit);
  const { rows } = await client.query<CatalogAllergen>(
    `select id, name, name_lower, kind, members from allergens
     ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
     order by name_lower COLLATE "C", id
     limit $${params.length}`,
    params,
  );
  return rows;
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
 * The allergies written on the records merged into this patient (#843), newest list first, so a
 * survivor's allergy list shows them. Read only: saving the list adopts what the person kept.
 */
export async function mergedAllergies(
  client: pg.ClientBase,
  patientId: string,
): Promise<Allergy[]> {
  const family = (await patientFamily(client, patientId)).filter((id) => id !== patientId);
  if (family.length === 0) return [];
  const { rows } = await client.query<{ items: Allergy[] }>(
    `select items from allergy_lists where patient_id = any($1::uuid[]) and status = 'listed'
     order by updated_at desc, patient_id`,
    [family],
  );
  return rows.flatMap((row) => row.items);
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
