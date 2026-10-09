import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { HttpError } from '../http/errors.js';
import { errors, ref, StringEnum } from '../http/schemas.js';
import { tenantFeatures, tenants } from './schema.js';

/** A hospital's configuration, as the web app receives it. */
export const Tenant = Type.Object(
  {
    id: Type.String(),
    slug: Type.String(),
    name: Type.String(),
    locale: Type.String({ description: 'BCP 47, e.g. en-IN' }),
    timezone: Type.String({ description: 'IANA, e.g. Asia/Kolkata' }),
    currency: Type.String({ description: 'ISO 4217' }),
    theme: Type.Object({
      primary: Type.String({
        pattern: '^#[0-9a-fA-F]{6}$',
        description:
          'Brand colour as six-digit hex. Must read as text on a white background (contrast of at least 4.5:1); the web app falls back to its default colour otherwise.',
      }),
      logoUrl: Type.Optional(
        Type.String({
          description:
            'https or same-origin URL of the hospital logo (SVG or WebP, at most 50 kB).',
        }),
      ),
    }),
    features: Type.Unsafe<Record<string, boolean>>({
      type: 'object',
      additionalProperties: { type: 'boolean' },
      description: 'Module flags. A module that is absent is off.',
    }),
    auth: Type.Object({ mode: StringEnum(['password', 'sso']) }),
    status: StringEnum(['active', 'suspended'], {
      description:
        'A suspended hospital keeps its data but its staff cannot use the app. Tenant-scoped routes answer 403 tenant_suspended.',
    }),
  },
  { $id: 'Tenant' },
);
export type Tenant = Static<typeof Tenant>;

export const tenantRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/tenant',
    {
      schema: {
        operationId: 'getTenant',
        tags: ['tenancy'],
        description:
          'The active hospital of the session and its configuration. Private per session, never CDN-cached.',
        response: { 200: ref(Tenant), ...errors(401, 403, 409) },
      },
    },
    async (request): Promise<Tenant> => {
      // No WHERE clause on purpose: row-level security leaves exactly the session's hospital.
      // If this ever returned another hospital's row, the tests in test/tenancy.test.ts fail.
      const [tenant] = await request.tx.select().from(tenants);
      if (!tenant) throw new HttpError(409, 'no_active_tenant', 'The hospital no longer exists');
      const flags = await request.tx.select().from(tenantFeatures);

      return toTenant(tenant, flags);
    },
  );
};

/** The API shape of a hospital, from its row and its module flags. */
export function toTenant(
  tenant: typeof tenants.$inferSelect,
  flags: (typeof tenantFeatures.$inferSelect)[],
): Tenant {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    locale: tenant.locale,
    timezone: tenant.timezone,
    currency: tenant.currency,
    theme: {
      primary: tenant.themePrimary,
      ...(tenant.themeLogoUrl ? { logoUrl: tenant.themeLogoUrl } : {}),
    },
    features: Object.fromEntries(flags.map((flag) => [flag.feature, flag.enabled])),
    auth: { mode: tenant.authMode },
    status: tenant.status,
  };
}
