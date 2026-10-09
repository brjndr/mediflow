import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadConfig, type Config } from '../src/core/config/config.js';
import type { Session } from '../src/core/session/plugin.js';
import { APP_ROLE } from '../src/core/tenancy/plugin.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ ...process.env, NODE_ENV: 'test' }), ...overrides };
}

interface TestAppOptions extends AppOptions {
  config?: Partial<Config>;
  /** Register extra routes before the app is ready (test-only probes). */
  extend?: (app: FastifyInstance) => void | Promise<void>;
}

/** The real app, driven in-process with `app.inject`. Close it when the test file is done. */
export async function buildTestApp(options: TestAppOptions = {}): Promise<FastifyInstance> {
  const { config, extend, ...appOptions } = options;
  const app = await buildApp(testConfig(config), appOptions);
  await extend?.(app);
  await app.ready();
  return app;
}

/**
 * Stands in for authentication, which does not exist yet: the session is read from a header that
 * only this resolver understands. `x-test-session: <userId>` or `<userId>:<tenantId>`.
 */
export const TEST_SESSION_HEADER = 'x-test-session';
export const resolveTestSession: AppOptions['resolveSession'] = async (request) => {
  const value = request.headers[TEST_SESSION_HEADER];
  if (typeof value !== 'string' || value === '') return null;
  const [userId, tenantId] = value.split(':');
  return { userId: userId ?? '', tenantId: tenantId || null } satisfies Session;
};

/** Headers for a request made as a user working in a hospital (or in none). */
export const as = (tenantId: string | null, userId = 'user_test') => ({
  [TEST_SESSION_HEADER]: tenantId ? `${userId}:${tenantId}` : userId,
});

export interface TestTenant {
  id: string;
  slug: string;
  name: string;
}

/**
 * Creates a hospital through the owner connection, as platform onboarding will. Slugs carry a
 * random suffix so test files and repeated runs never collide.
 */
export async function createTenant(
  pool: pg.Pool,
  name: string,
  overrides: {
    locale?: string;
    timezone?: string;
    currency?: string;
    themePrimary?: string;
    status?: 'active' | 'suspended';
    features?: Record<string, boolean>;
  } = {},
): Promise<TestTenant> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into tenants (slug, name, locale, timezone, currency, theme_primary, status)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      slug,
      name,
      overrides.locale ?? 'en-IN',
      overrides.timezone ?? 'Asia/Kolkata',
      overrides.currency ?? 'INR',
      overrides.themePrimary ?? '#0f766e',
      overrides.status ?? 'active',
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('tenant was not created');
  for (const [feature, enabled] of Object.entries(overrides.features ?? {})) {
    await pool.query(
      'insert into tenant_features (tenant_id, feature, enabled) values ($1, $2, $3)',
      [id, feature, enabled],
    );
  }
  return { id, slug, name };
}

/** Removes test hospitals and, by cascade, everything they own. */
export async function deleteTenants(pool: pg.Pool, tenants: TestTenant[]): Promise<void> {
  await pool.query('delete from tenants where id = any($1::uuid[])', [
    tenants.map((tenant) => tenant.id),
  ]);
}

/**
 * Runs SQL exactly as a request for that hospital would: in a transaction, under the app role,
 * with the tenant set. Pass null for a request with no tenant. Always rolled back.
 */
export async function asTenantSql<T>(
  pool: pg.Pool,
  tenantId: string | null,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${APP_ROLE}`);
    if (tenantId) await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    return await run(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
