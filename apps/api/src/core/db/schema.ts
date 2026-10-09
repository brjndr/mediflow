/**
 * Every Drizzle table, re-exported from the feature or core module that owns it. drizzle-kit and
 * the typed query builder read this file.
 *
 *   export * from '../../features/patients/schema.js';
 *
 * Tables arrive with BE-02 (tenants). Every tenant-owned table has a tenant_id column and a
 * row-level security policy written in its migration.
 */
export {};
