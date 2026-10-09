import { boolean, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle definitions of the tables created in migrations/0003_tenants.sql. The migration is the
 * source of truth for constraints and row-level security; these describe the columns to the
 * query builder.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  locale: text('locale').notNull(),
  timezone: text('timezone').notNull(),
  currency: text('currency').notNull(),
  themePrimary: text('theme_primary').notNull(),
  themeLogoUrl: text('theme_logo_url'),
  authMode: text('auth_mode', { enum: ['password', 'sso'] })
    .notNull()
    .default('password'),
  status: text('status', { enum: ['active', 'suspended'] })
    .notNull()
    .default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantFeatures = pgTable(
  'tenant_features',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    feature: text('feature').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.feature] })],
);
