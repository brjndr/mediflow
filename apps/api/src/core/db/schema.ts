/**
 * Every Drizzle table, re-exported from the feature or core module that owns it. The typed query
 * builder reads this file.
 *
 * Every tenant-owned table has a tenant_id column and row-level security applied in its
 * migration with `SELECT enable_tenant_rls('<table>')`.
 */
export * from '../tenancy/schema.js';
