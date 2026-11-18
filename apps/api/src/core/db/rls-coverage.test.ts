import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/helpers.js';

// Tables with a tenant_id column that are allowed to lack forced RLS, each with its reason.
// Keep this short: a new tenant table calls enable_tenant_rls() in its migration instead.
const NO_FORCED_RLS: Record<string, string> = {}; // sessions is forced too

// SECURITY DEFINER functions in the public schema. Adding one means reviewing it and listing it
// here; each must pin its search_path so a caller cannot shadow objects it uses.
const DEFINER_FUNCTIONS = new Set<string>([
  'audit_default_rows',
  'bump_policy_revision',
  'ensure_audit_partition',
  'invite_hospital_name',
  'is_platform_admin_email',
  'offboarding_admin_contacts',
  'patient_search_count',
  'patient_search_ids',
  'patient_search_short_page',
  'patient_search_short_words_page',
  'tenants_seed_price_list',
  'tenants_seed_roles',
]);

let pool: pg.Pool;
beforeAll(() => {
  pool = new pg.Pool({ connectionString: testConfig().DATABASE_URL });
});
afterAll(async () => {
  await pool.end();
});

describe('row-level security coverage', () => {
  it('every table with a tenant_id column has enabled and forced RLS', async () => {
    const { rows } = await pool.query<{ table: string; enabled: boolean; forced: boolean }>(`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      order by c.relname`);
    expect(rows.length).toBeGreaterThan(50);
    const missing = rows
      .filter((r) => !(r.enabled && r.forced) && !(r.table in NO_FORCED_RLS))
      .map((r) => r.table);
    expect(missing).toEqual([]);
  });

  it('every allowlisted exception still exists and still lacks forced RLS', async () => {
    if (Object.keys(NO_FORCED_RLS).length === 0) return;
    const { rows } = await pool.query<{ table: string; ok: boolean }>(
      `select c.relname as table, (c.relrowsecurity and c.relforcerowsecurity) as ok
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1)`,
      [Object.keys(NO_FORCED_RLS)],
    );
    // An exception that gained forced RLS, or was dropped, must leave the list.
    expect(
      rows
        .filter((r) => !r.ok)
        .map((r) => r.table)
        .sort(),
    ).toEqual(Object.keys(NO_FORCED_RLS).sort());
  });

  it('SECURITY DEFINER functions are the known ones and each sets a search_path', async () => {
    const { rows } = await pool.query<{ name: string; config: string[] | null }>(`
      select p.proname as name, p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
      order by p.proname`);
    expect(rows.map((r) => r.name)).toEqual([...DEFINER_FUNCTIONS].sort());
    const unpinned = rows
      .filter((r) => !(r.config ?? []).some((c) => c.startsWith('search_path=')))
      .map((r) => r.name);
    expect(unpinned).toEqual([]);
  });
});
