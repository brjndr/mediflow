// Run with `pnpm --filter api db:seed`. Development only.
//
// Fills the local database with the same two sample hospitals and four sample staff the web
// app's mock API has, so the real API can be signed in to. Synthetic data only. Safe to run
// again: existing rows are updated in place.
import pg from 'pg';
import { hashPassword } from '../src/core/auth/password.js';
import { loadConfig } from '../src/core/config/config.js';

/** The one password of every sample account. Printed below; it protects nothing. */
const DEV_PASSWORD = 'sample-staff-local-only';

const HOSPITALS = [
  {
    slug: 'sample-hospital',
    name: 'Sample Hospital',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    themePrimary: '#0f766e',
    features: {
      patients: true,
      appointments: true,
      clinical: true,
      laboratory: true,
      radiology: true,
      pharmacy: true,
      billing: true,
      reports: true,
    },
  },
  {
    // A small OPD clinic: diagnostics and pharmacy are switched off.
    slug: 'riverside-clinic',
    name: 'Riverside Clinic',
    locale: 'en-GB',
    timezone: 'Asia/Dubai',
    currency: 'AED',
    themePrimary: '#4338ca',
    features: {
      patients: true,
      appointments: true,
      clinical: true,
      laboratory: false,
      radiology: false,
      pharmacy: false,
      billing: true,
      reports: false,
    },
  },
] as const;

const STAFF = [
  {
    email: 'admin@sample-hospital.test',
    name: 'Sample Admin',
    memberships: [{ slug: 'sample-hospital', roleId: 'admin' }],
  },
  {
    // Works at both hospitals, so picks one after signing in.
    email: 'doctor@sample-hospital.test',
    name: 'Sample Doctor',
    memberships: [
      { slug: 'sample-hospital', roleId: 'doctor' },
      { slug: 'riverside-clinic', roleId: 'doctor' },
    ],
  },
  {
    email: 'reception@riverside-clinic.test',
    name: 'Sample Receptionist',
    memberships: [{ slug: 'riverside-clinic', roleId: 'receptionist' }],
  },
  {
    email: 'billing@riverside-clinic.test',
    name: 'Sample Billing Clerk',
    memberships: [{ slug: 'riverside-clinic', roleId: 'billing_clerk' }],
  },
] as const;

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed sample accounts in production.\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: config.DATABASE_URL });
await client.connect();
try {
  await client.query('begin');

  const tenantIds = new Map<string, string>();
  for (const hospital of HOSPITALS) {
    const { rows } = await client.query<{ id: string }>(
      `insert into tenants (slug, name, locale, timezone, currency, theme_primary)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (slug) do update
         set name = excluded.name, locale = excluded.locale, timezone = excluded.timezone,
             currency = excluded.currency, theme_primary = excluded.theme_primary
       returning id`,
      [
        hospital.slug,
        hospital.name,
        hospital.locale,
        hospital.timezone,
        hospital.currency,
        hospital.themePrimary,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`could not seed ${hospital.slug}`);
    tenantIds.set(hospital.slug, id);
    for (const [feature, enabled] of Object.entries(hospital.features)) {
      await client.query(
        `insert into tenant_features (tenant_id, feature, enabled) values ($1, $2, $3)
         on conflict (tenant_id, feature) do update set enabled = excluded.enabled`,
        [id, feature, enabled],
      );
    }
  }

  const secretHash = await hashPassword(DEV_PASSWORD);
  for (const person of STAFF) {
    const { rows } = await client.query<{ id: string }>(
      `insert into users (email, name) values ($1, $2)
       on conflict (email) do update set name = excluded.name, updated_at = now()
       returning id`,
      [person.email, person.name],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error(`could not seed ${person.email}`);
    await client.query(
      `insert into user_identities (user_id, provider, subject, secret_hash)
       values ($1::uuid, 'password', $1::text, $2)
       on conflict (provider, subject) do update
         set secret_hash = excluded.secret_hash, updated_at = now()`,
      [userId, secretHash],
    );
    for (const membership of person.memberships) {
      await client.query(
        `insert into memberships (tenant_id, user_id, role_id) values ($1, $2, $3)
         on conflict (tenant_id, user_id) do update
           set role_id = excluded.role_id, status = 'active', updated_at = now()`,
        [tenantIds.get(membership.slug), userId, membership.roleId],
      );
    }
  }

  await client.query('commit');
  process.stdout.write(
    `Seeded ${HOSPITALS.length} hospitals and ${STAFF.length} staff.\n` +
      `Sign in as any of:\n${STAFF.map((person) => `  ${person.email}`).join('\n')}\n` +
      `Password: ${DEV_PASSWORD}\n`,
  );
} catch (error) {
  await client.query('rollback');
  process.stderr.write(`${error instanceof Error ? error.message : 'Seeding failed.'}\n`);
  process.exitCode = 1;
} finally {
  await client.end();
}
