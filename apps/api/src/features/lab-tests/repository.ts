import type pg from 'pg';
import type { AgeUnit } from './age.js';
import type {
  LabDepartment,
  LabKind,
  LabRange,
  LabTestComponent,
  RangeSex,
  ResultType,
  SampleType,
} from './schemas.js';

/**
 * The lab tests SQL. Every statement runs on the request's own transaction, so row-level
 * security limits it to the active hospital: no statement here names a tenant.
 */

export interface LabTestRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  name_lower: string;
  department: LabDepartment;
  kind: LabKind;
  result_type: ResultType;
  unit: string | null;
  sample_type: SampleType;
  container: string | null;
  turnaround_hours: number;
  service_id: string | null;
  /** The name of the linked service. The name alone: nothing else of a service is read here. */
  service_name: string | null;
  archived: boolean;
  version: number;
  ranges_version: number;
}

/** What a request can set on a test. */
export interface LabTestDetails {
  name: string;
  department: LabDepartment;
  resultType: ResultType;
  unit: string | null;
  sampleType: SampleType;
  container: string | null;
  turnaroundHours: number;
  serviceId: string | null;
}

const SELECT = `
  select t.id, t.tenant_id, t.code, t.name, t.name_lower, t.department, t.kind, t.result_type,
    t.unit, t.sample_type, t.container, t.turnaround_hours, t.service_id, s.name as service_name,
    t.archived, t.version, t.ranges_version
  from lab_tests t
  left join services s on s.tenant_id = t.tenant_id and s.id = t.service_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/** Where the next page starts: after this row, in name order. A name and an id, no more. */
interface Cursor {
  n: string;
  i: string;
}

const encodeCursor = (row: LabTestRow): string =>
  Buffer.from(JSON.stringify({ n: row.name_lower, i: row.id } satisfies Cursor)).toString(
    'base64url',
  );

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, i } = value as Record<string, unknown>;
    if (typeof n !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
    // A name this module stored: never longer than a name (in characters, as the database
    // counts them), never a character Postgres refuses.
    return [...n].length <= 150 && !n.includes('\u0000') ? { n, i } : null;
  } catch {
    return null;
  }
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export interface LabTestSearch {
  q?: string;
  department?: LabDepartment;
  kind?: LabKind;
  archived: boolean;
  cursor?: string;
  limit: number;
}

export interface LabTestList {
  rows: LabTestRow[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/**
 * One page of the hospital's active (or archived) tests and panels, by name. Every word of the
 * term must be in the code or the name. The rows are found through the tenant index and the text
 * matched against those: a text index is never used under row-level security. Null for a bad
 * cursor.
 */
export async function searchLabTests(
  client: pg.ClientBase,
  { q, department, kind, archived, cursor, limit }: LabTestSearch,
): Promise<LabTestList | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;

  const params: unknown[] = [archived];
  const where = ['t.archived = $1'];
  const only = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  };
  only('t.department', department);
  only('t.kind', kind);
  for (const word of (q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(likePattern(word));
    // The database lower-cases both sides: its idea of lower case is not JavaScript's.
    where.push(`t.search_text like lower($${params.length})`);
  }
  const filters = params.length;

  params.push(after?.n ?? null, after?.i ?? null, limit + 1);
  const [n, i, max] = [filters + 1, filters + 2, filters + 3];
  const { rows } = await client.query<LabTestRow>(
    `${SELECT}
     where ${where.join(' and ')}
       and ($${n}::text is null or (t.name_lower, t.id) > ($${n}, $${i}::uuid))
     order by t.name_lower, t.id
     limit $${max}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: LabTestList = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from lab_tests t where ${where.join(' and ')}`,
      params.slice(0, filters),
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** The test, or null when this hospital has none such. */
export async function findLabTest(client: pg.ClientBase, id: string): Promise<LabTestRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<LabTestRow>(`${SELECT} where t.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The test, locked until the transaction ends, or null when this hospital has none such. Every
 * change of a test, of its components and of its ranges starts here, so they take their turn.
 */
export async function lockLabTest(client: pg.ClientBase, id: string): Promise<LabTestRow | null> {
  if (!UUID.test(id)) return null;
  const locked = await client.query('select 1 from lab_tests where id = $1 for update', [id]);
  return locked.rowCount === 1 ? findLabTest(client, id) : null;
}

/** The components of each of these panels, in the order they are reported. */
export async function componentsOf(
  client: pg.ClientBase,
  panelIds: readonly string[],
): Promise<Map<string, LabTestComponent[]>> {
  const byPanel = new Map<string, LabTestComponent[]>();
  if (panelIds.length === 0) return byPanel;
  const { rows } = await client.query<{ panel_id: string } & LabTestComponent>(
    `select c.panel_id, t.id, t.code, t.name
     from lab_test_components c
     join lab_tests t on t.tenant_id = c.tenant_id and t.id = c.component_id
     where c.panel_id = any($1::uuid[])
     order by c.panel_id, c.position`,
    [panelIds],
  );
  for (const { panel_id: panelId, ...component } of rows) {
    const list = byPanel.get(panelId) ?? [];
    list.push(component);
    byPanel.set(panelId, list);
  }
  return byPanel;
}

/** Whether the hospital already has a test of this code, archived or not. */
export async function codeTaken(client: pg.ClientBase, code: string): Promise<boolean> {
  const { rowCount } = await client.query('select 1 from lab_tests where code_lower = lower($1)', [
    code,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Whether an error is the database refusing a second test of the same code. */
export const isCodeTaken = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  (error as { constraint?: unknown }).constraint === 'lab_tests_code_taken';

/** Whether this is a laboratory service of the hospital that is in use: what a test can be linked to. */
export async function isLabService(client: pg.ClientBase, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await client.query(
    "select 1 from services where id = $1 and category = 'lab' and not archived",
    [id],
  );
  return rowCount === 1;
}

/**
 * The laboratory service of this hospital in use with this code, whatever its capitals: how a
 * file of tests names what each is charged as.
 */
export async function labServiceByCode(
  client: pg.ClientBase,
  code: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "select id from services where lower(code) = lower($1) and category = 'lab' and not archived",
    [code],
  );
  return rows[0]?.id ?? null;
}

/**
 * Locks the tests named as the components of a panel, in id order so that two requests naming
 * the same tests cannot wait on each other, and says whether each is a single test of this
 * hospital that is in use. A test being archived at the same moment waits for this, or this for
 * it: either the panel does not get it, or it is not archived.
 */
export async function lockUsableComponents(
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<boolean> {
  if (ids.some((id) => !UUID.test(id))) return false;
  // Single tests only are locked: a panel named by mistake is refused without being held, so
  // two panels that name each other cannot wait on each other.
  const { rows } = await client.query<{ archived: boolean }>(
    `select archived from lab_tests
     where id = any($1::uuid[]) and kind = 'test' order by id for update`,
    [ids],
  );
  return rows.length === ids.length && rows.every((row) => !row.archived);
}

/** Whether any of the tests a panel is made of is archived. */
export async function hasArchivedComponent(
  client: pg.ClientBase,
  panelId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from lab_test_components c
     join lab_tests t on t.tenant_id = c.tenant_id and t.id = c.component_id
     where c.panel_id = $1 and t.archived
     limit 1`,
    [panelId],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertLabTest(
  client: pg.ClientBase,
  input: LabTestDetails & { code: string; kind: LabKind },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into lab_tests (tenant_id, code, name, department, kind, result_type, unit,
       sample_type, container, turnaround_hours, service_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      input.code,
      input.name,
      input.department,
      input.kind,
      input.resultType,
      input.unit,
      input.sampleType,
      input.container,
      input.turnaroundHours,
      input.serviceId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('test was not created');
  return id;
}

/** Saves the details of a test. Any update counts a version, also one of the components alone. */
export async function updateLabTest(
  client: pg.ClientBase,
  id: string,
  details: LabTestDetails,
): Promise<void> {
  const { rowCount } = await client.query(
    `update lab_tests set name = $2, department = $3, result_type = $4, unit = $5,
       sample_type = $6, container = $7, turnaround_hours = $8, service_id = $9
     where id = $1`,
    [
      id,
      details.name,
      details.department,
      details.resultType,
      details.unit,
      details.sampleType,
      details.container,
      details.turnaroundHours,
      details.serviceId,
    ],
  );
  if (rowCount !== 1) throw new Error('test was not updated');
}

/** Replaces the components of a panel, in the order given. */
export async function replaceComponents(
  client: pg.ClientBase,
  panelId: string,
  componentIds: readonly string[],
): Promise<void> {
  await client.query('delete from lab_test_components where panel_id = $1', [panelId]);
  if (componentIds.length === 0) return;
  await client.query(
    `insert into lab_test_components (tenant_id, panel_id, component_id, position)
     select app_tenant_id(), $1, component, position - 1
     from unnest($2::uuid[]) with ordinality as part (component, position)`,
    [panelId, componentIds],
  );
}

/** Whether the test is a component of a panel that is in use. */
export async function inPanelInUse(client: pg.ClientBase, testId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from lab_test_components c
     join lab_tests p on p.tenant_id = c.tenant_id and p.id = c.panel_id
     where c.component_id = $1 and not p.archived
     limit 1`,
    [testId],
  );
  return (rowCount ?? 0) > 0;
}

/** Archives or restores. False when the test is already as asked: nothing is written. */
export async function setArchived(
  client: pg.ClientBase,
  id: string,
  archived: boolean,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'update lab_tests set archived = $2 where id = $1 and archived <> $2',
    [id, archived],
  );
  return rowCount === 1;
}

interface RangeRow {
  sex: RangeSex;
  age_from_value: number;
  age_from_unit: AgeUnit;
  age_until_value: number | null;
  age_until_unit: AgeUnit | null;
  low: number | null;
  high: number | null;
  critical_low: number | null;
  critical_high: number | null;
  note: string | null;
}

/** The reference ranges of a test, in the order they were saved. */
export async function listRanges(client: pg.ClientBase, testId: string): Promise<LabRange[]> {
  const { rows } = await client.query<RangeRow>(
    `select sex, age_from_value, age_from_unit, age_until_value, age_until_unit,
       low, high, critical_low, critical_high, note
     from lab_test_ranges where lab_test_id = $1 order by position`,
    [testId],
  );
  return rows.map((row): LabRange => ({
    sex: row.sex,
    ageFrom: { value: row.age_from_value, unit: row.age_from_unit },
    ...(row.age_until_value === null || row.age_until_unit === null
      ? {}
      : { ageUntil: { value: row.age_until_value, unit: row.age_until_unit } }),
    ...(row.low === null ? {} : { low: row.low }),
    ...(row.high === null ? {} : { high: row.high }),
    ...(row.critical_low === null ? {} : { criticalLow: row.critical_low }),
    ...(row.critical_high === null ? {} : { criticalHigh: row.critical_high }),
    ...(row.note === null ? {} : { note: row.note }),
  }));
}

/** Whether the test has any reference range. */
export async function hasRanges(client: pg.ClientBase, testId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from lab_test_ranges where lab_test_id = $1 limit 1',
    [testId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Replaces the reference ranges of a test and counts their version. The version it now has.
 * The test is locked by the caller.
 */
export async function replaceRanges(
  client: pg.ClientBase,
  testId: string,
  ranges: readonly LabRange[],
): Promise<number> {
  await client.query('delete from lab_test_ranges where lab_test_id = $1', [testId]);
  for (const [position, range] of ranges.entries()) {
    await client.query(
      `insert into lab_test_ranges (tenant_id, lab_test_id, position, sex, age_from_value,
         age_from_unit, age_until_value, age_until_unit, low, high, critical_low, critical_high,
         note)
       values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        testId,
        position,
        range.sex,
        range.ageFrom.value,
        range.ageFrom.unit,
        range.ageUntil?.value ?? null,
        range.ageUntil?.unit ?? null,
        range.low ?? null,
        range.high ?? null,
        range.criticalLow ?? null,
        range.criticalHigh ?? null,
        range.note ?? null,
      ],
    );
  }
  // The trigger counts: whatever is set here, the version goes up by one.
  const { rows } = await client.query<{ ranges_version: number }>(
    `update lab_tests set ranges_version = ranges_version + 1 where id = $1
     returning ranges_version`,
    [testId],
  );
  const version = rows[0]?.ranges_version;
  if (version === undefined) throw new Error('the ranges were not saved');
  return version;
}
