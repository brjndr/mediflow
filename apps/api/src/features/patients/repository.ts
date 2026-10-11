import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import type { PatientCreate, PatientSort, PatientUpdate } from './schemas.js';

/**
 * Every query here runs on the request's transaction client: under the app role, with the
 * hospital set from the session. Row-level security keeps it to that hospital; nothing in this
 * file filters by tenant to isolate, only by what the caller asked for and may see.
 *
 * Row-level security also decides what an index can do: only a leakproof operator may be an
 * index condition. Equality and ordering on plain columns are; `LIKE` and `lower()` are not. So
 * the list is ordered and paged on the stored lower-case name columns, and a text search is a
 * filter over the hospital's rows.
 */

export interface PatientRow {
  id: string;
  tenant_id: string;
  mrn: string;
  first_name: string;
  last_name: string;
  dob: string;
  gender: 'male' | 'female' | 'other';
  phone: string;
  email: string | null;
  address: string | null;
  contact_consent_given: boolean | null;
  contact_consent_at: Date | null;
  contact_consent_recorded_by: string | null;
}

const COLUMNS = `id, tenant_id, mrn, first_name, last_name, dob::text as dob, gender, phone, email,
  address, contact_consent_given, contact_consent_at, contact_consent_recorded_by`;

/** Who may the caller see, given the scope their role holds the permission with. */
export interface Visibility {
  scope: PermissionScope;
  userId: string;
}

/**
 * `own` means the records the user registered, until encounters exist to say whose patient
 * someone is. `department` matches nothing yet: there are no departments to belong to.
 */
function visibilityClause(visibility: Visibility, params: unknown[]): string | null {
  if (visibility.scope === 'all') return null;
  if (visibility.scope === 'own') {
    params.push(visibility.userId);
    return `created_by = $${params.length}`;
  }
  return 'false';
}

/** Escapes what the user typed so it is matched as text, not as a LIKE pattern. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** The columns each order runs on, most significant first. The id makes every order total. */
const SORT_COLUMNS: Record<PatientSort, readonly string[]> = {
  name: ['last_name_lower', 'first_name_lower', 'id'],
  '-name': ['last_name_lower', 'first_name_lower', 'id'],
  mrn: ['mrn', 'id'],
  '-mrn': ['mrn', 'id'],
};
const descending = (sort: PatientSort) => sort.startsWith('-');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cursor names the last row of the previous page and the order it was read in. No data. */
const encodeCursor = (sort: PatientSort, id: string) =>
  Buffer.from(`${sort}:${id}`).toString('base64url');

function decodeCursor(cursor: string, sort: PatientSort): string {
  const [cursorSort, id] = Buffer.from(cursor, 'base64url').toString().split(':');
  if (cursorSort !== sort || !id || !UUID.test(id)) {
    throw new HttpError(400, 'invalid_cursor', 'The cursor does not belong to this list');
  }
  return id;
}

/** Looks like a phone number: digits and the punctuation people type around them. */
const PHONE_SHAPED = /^[+\d\s().-]+$/;

export interface SearchInput {
  /**
   * Whether the term may be matched against phone numbers. Only for a caller who may see them:
   * otherwise a masked number could be recovered digit by digit from what matches.
   */
  byPhone: boolean;
  q?: string;
  cursor?: string;
  limit: number;
  sort: PatientSort;
}

export async function searchPatients(
  client: pg.PoolClient,
  input: SearchInput,
  visibility: Visibility,
): Promise<{ rows: PatientRow[]; nextCursor: string | null; total?: number }> {
  const params: unknown[] = [];
  const where: string[] = [];

  const visible = visibilityClause(visibility, params);
  if (visible) where.push(visible);

  const term = input.q?.trim().toLowerCase() ?? '';
  if (term !== '') {
    // Every word must appear, in any order: "verma asha" finds Asha Verma.
    const words = term.split(/\s+/).map((word) => {
      params.push(likePattern(word));
      return `search_text like $${params.length}`;
    });
    const matches = [`(${words.join(' and ')})`];
    // Only something that looks like a phone number is tried as one, so the digits of an MRN
    // do not bring in everyone whose phone happens to contain them.
    const digits = term.replace(/\D/g, '');
    if (input.byPhone && PHONE_SHAPED.test(term) && digits.length >= 3) {
      params.push(likePattern(digits));
      matches.push(`phone_digits like $${params.length}`);
    }
    where.push(`(${matches.join(' or ')})`);
  }

  // Counted on the first page only: the number does not change while someone pages through.
  let total: number | undefined;
  if (!input.cursor) {
    const counted = await client.query<{ total: string }>(
      `select count(*) as total from patients ${where.length ? `where ${where.join(' and ')}` : ''}`,
      params,
    );
    total = Number(counted.rows[0]?.total ?? 0);
  }

  const columns = SORT_COLUMNS[input.sort];
  const direction = descending(input.sort) ? 'desc' : 'asc';
  if (input.cursor) {
    // The row the cursor names is read under the same row-level security and the same scope as
    // the page, so a cursor naming a row the caller may not see (another hospital's, or a
    // colleague's under the "own" scope) names nothing and the page is empty. Its values are
    // then passed as parameters, which lets the comparison be an index condition.
    const cursorParams: unknown[] = [decodeCursor(input.cursor, input.sort)];
    const cursorVisible = visibilityClause(visibility, cursorParams);
    const cursorRow = await client.query<Record<string, string>>(
      `select ${columns.join(', ')} from patients where id = $1 ${cursorVisible ? `and ${cursorVisible}` : ''}`,
      cursorParams,
    );
    const last = cursorRow.rows[0];
    if (!last) return { rows: [], nextCursor: null };
    const placeholders = columns.map((column) => {
      params.push(last[column]);
      return `$${params.length}${column === 'id' ? '::uuid' : ''}`;
    });
    where.push(
      `(${columns.join(', ')}) ${direction === 'asc' ? '>' : '<'} (${placeholders.join(', ')})`,
    );
  }

  params.push(input.limit + 1);
  const { rows } = await client.query<PatientRow>(
    `select ${COLUMNS} from patients
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by ${columns.map((column) => `${column} ${direction}`).join(', ')}
     limit $${params.length}`,
    params,
  );

  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(input.sort, last.id) : null,
    total,
  };
}

export async function findPatient(
  client: pg.PoolClient,
  id: string,
  visibility: Visibility,
  options: { forUpdate?: boolean } = {},
): Promise<PatientRow | null> {
  if (!UUID.test(id)) return null;
  const params: unknown[] = [id];
  const visible = visibilityClause(visibility, params);
  const { rows } = await client.query<PatientRow>(
    `select ${COLUMNS} from patients where id = $1 ${visible ? `and ${visible}` : ''}
     ${options.forUpdate ? 'for update' : ''}`,
    params,
  );
  return rows[0] ?? null;
}

/** Today's date where the hospital is, as YYYY-MM-DD. A birth date cannot be after it. */
export async function todayAtHospital(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    'select (now() at time zone timezone)::date::text as today from tenants where id = app_tenant_id()',
  );
  const today = rows[0]?.today;
  if (!today) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');
  return today;
}

/** Initials of the hospital's slug, e.g. `sample-hospital` gives `SH`. */
export function mrnPrefix(slug: string): string {
  const initials = slug
    .split('-')
    .map((part) => part[0] ?? '')
    .join('')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 3)
    .toUpperCase();
  return initials || 'P';
}

/** Seven digits, so MRNs sort as text up to ten million patients per hospital. */
export const MRN_DIGITS = 7;
export const formatMrn = (prefix: string, value: number | string) =>
  `${prefix}-${String(value).padStart(MRN_DIGITS, '0')}`;

/**
 * The next MRN of the active hospital. The counter row stays locked until the request commits,
 * so two registrations at once cannot share a number and a failed one leaves no gap.
 */
async function nextMrn(client: pg.PoolClient): Promise<string> {
  const counter = await client.query<{ last_value: string }>(
    `insert into patient_mrn_counters (tenant_id, last_value) values (app_tenant_id(), 1)
     on conflict (tenant_id) do update set last_value = patient_mrn_counters.last_value + 1
     returning last_value`,
  );
  const tenant = await client.query<{ slug: string }>(
    'select slug from tenants where id = app_tenant_id()',
  );
  const value = counter.rows[0]?.last_value;
  const slug = tenant.rows[0]?.slug;
  if (!value || !slug) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');
  return formatMrn(mrnPrefix(slug), value);
}

export async function insertPatient(
  client: pg.PoolClient,
  input: PatientCreate,
  userId: string,
): Promise<PatientRow> {
  const mrn = await nextMrn(client);
  const consent = input.contactConsent;
  const { rows } = await client.query<PatientRow>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, email, address,
       contact_consent_given, contact_consent_at, contact_consent_recorded_by, created_by)
     values (app_tenant_id(), $1, $2, $3, $4::date, $5, $6, $7, $8, $9,
       case when $9::boolean is null then null else now() end,
       case when $9::boolean is null then null else $10 end, $10)
     returning ${COLUMNS}`,
    [
      mrn,
      input.firstName,
      input.lastName,
      input.dob,
      input.gender,
      input.phone,
      input.email ?? null,
      input.address ?? null,
      consent ? consent.given : null,
      userId,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('patient was not created');
  return row;
}

const UPDATABLE = {
  firstName: 'first_name',
  lastName: 'last_name',
  dob: 'dob',
  gender: 'gender',
  phone: 'phone',
  email: 'email',
  address: 'address',
} as const;

/**
 * Applies the changes that really change something and returns the row with their field names.
 * Sending a value the record already has is not a change: nothing is written and no field is
 * named, so the caller emits no event for it.
 */
export async function updatePatient(
  client: pg.PoolClient,
  existing: PatientRow,
  changes: PatientUpdate,
  userId: string,
): Promise<{ row: PatientRow; fields: string[] }> {
  const params: unknown[] = [existing.id];
  const sets: string[] = [];
  const fields: string[] = [];
  for (const [field, column] of Object.entries(UPDATABLE)) {
    const value = changes[field as keyof typeof UPDATABLE];
    if (value === undefined || value === existing[column]) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}${column === 'dob' ? '::date' : ''}`);
    fields.push(field);
  }
  // A consent decision is recorded anew only when it differs from the one on record.
  const consent = changes.contactConsent;
  if (consent && consent.given !== existing.contact_consent_given) {
    params.push(consent.given, userId);
    sets.push(
      `contact_consent_given = $${params.length - 1}`,
      'contact_consent_at = now()',
      `contact_consent_recorded_by = $${params.length}`,
    );
    fields.push('contactConsent');
  }
  if (sets.length === 0) return { row: existing, fields };
  const { rows } = await client.query<PatientRow>(
    `update patients set ${sets.join(', ')} where id = $1 returning ${COLUMNS}`,
    params,
  );
  const row = rows[0];
  if (!row) throw new Error('patient was not updated');
  return { row, fields };
}

/**
 * People already registered who may be the same person: the same birth date and name, or the
 * same phone number with the same birth date or surname. Phone numbers are compared by their
 * last ten digits, so a country code typed one time and not the other still matches.
 */
export async function findDuplicates(
  client: pg.PoolClient,
  query: { firstName: string; lastName: string; dob: string; phone: string },
): Promise<PatientRow[]> {
  const digits = query.phone.replace(/\D/g, '').slice(-10);
  const { rows } = await client.query<PatientRow>(
    `select ${COLUMNS} from patients
     where (dob = $1::date and first_name_lower = lower($2) and last_name_lower = lower($3))
        or (phone_last10 = $4 and length($4) >= 7 and (dob = $1::date or last_name_lower = lower($3)))
     order by last_name_lower, first_name_lower, id
     limit 5`,
    [query.dob, query.firstName, query.lastName, digits],
  );
  return rows;
}
