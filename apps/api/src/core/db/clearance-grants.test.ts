import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, deleteTenants, type TestTenant } from '../../../test/helpers.js';
import { testConfig } from '../../../test/helpers.js';

const sql = readFileSync(
  join(import.meta.dirname, '../../migrations/0105_clearance_grants_custom_roles.sql'),
  'utf8',
);
let pool: pg.Pool;
let a: TestTenant;
let b: TestTenant;

const grants = async (tenant: TestTenant, role: string) =>
  (
    await pool.query<{ permission: string; scope: string }>(
      'select permission, scope from role_permissions where tenant_id = $1 and role_id = $2 order by permission',
      [tenant.id, role],
    )
  ).rows;

async function role(tenant: TestTenant, id: string, builtIn: boolean, scope = 'all') {
  await pool.query('insert into roles (tenant_id, id, name, built_in) values ($1, $2, $2, $3)', [
    tenant.id,
    id,
    builtIn,
  ]);
  await pool.query(
    "insert into role_permissions (tenant_id, role_id, permission, scope) values ($1, $2, 'discharge:clear', $3)",
    [tenant.id, id, scope],
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: testConfig().DATABASE_URL });
  a = await createTenant(pool, 'Clearance A');
  b = await createTenant(pool, 'Clearance B');
  await role(a, 'ward_clerk', false, 'department');
  await role(a, 'old_builtin', true);
  await pool.query('insert into roles (tenant_id, id, name) values ($1, $2, $2)', [b.id, 'other']);
});
afterAll(async () => {
  await deleteTenants(pool, [a, b]);
  await pool.end();
});

describe('0105 clearance grants', () => {
  it('gives a custom role the three permissions, once, and touches nothing else', async () => {
    await pool.query(sql);
    await pool.query(sql);
    expect((await grants(a, 'ward_clerk')).map((g) => [g.permission, g.scope])).toEqual([
      ['discharge:clear', 'department'],
      ['discharge:clearLab', 'department'],
      ['discharge:clearNursing', 'department'],
      ['discharge:clearPharmacy', 'department'],
    ]);
    expect(await grants(a, 'old_builtin')).toHaveLength(1);
    expect(await grants(b, 'other')).toHaveLength(0);
  });
});
