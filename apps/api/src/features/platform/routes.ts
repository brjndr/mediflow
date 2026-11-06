import { createHash, randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { syncRoleDefaults } from '../../core/access/sync.js';
import { queueInviteEmail } from '../../core/auth/emails.js';
import { normalizeEmail } from '../../core/auth/login.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { searchTerm, tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { withPlatformTransaction } from '../../core/platform/db.js';
import { OFFBOARD_JOB, type OffboardJob } from './jobs.js';
import {
  claimKey,
  createAdminInvite,
  endHospitalSessions,
  hasActiveAdmin,
  isPlatformAdminEmail,
  withdrawOpenInvites,
  findHospital,
  getHospital,
  listAudit,
  listHospitals,
  listOpenInvites,
  revokeOpenInvite,
  recordPlatformAudit,
  rememberKey,
  requestHash,
} from './repository.js';
import {
  AdminInviteBody,
  AuditQuery,
  CreateHospitalBody,
  HospitalParams,
  InviteParams,
  ListHospitalsQuery,
  OffboardBody,
  PlatformAuditPage,
  PlatformHospital,
  PlatformHospitalPage,
  PlatformInvite,
  PlatformInvitePage,
  PlatformModuleList,
  SetFeaturesBody,
  UpdateHospitalBody,
} from './schemas.js';

/** Module flags that are not modules: the second factor's two switches (core/auth). */
const AUTH_SWITCHES = ['mfa', 'mfa_required'];

/** A text field of a request, which the schema has already checked. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const UNIQUE_VIOLATION = '23505';
const isUnique = (error: unknown, constraint: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
  (error as { constraint?: unknown }).constraint === constraint;

function checkLocale(locale: string): string {
  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    if (canonical) return canonical;
  } catch {
    // Refused below.
  }
  throw new HttpError(400, 'validation_failed', 'locale is not a language tag');
}

function checkTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new HttpError(400, 'validation_failed', 'timezone is not a known zone');
  }
}

function checkCurrency(currency: string): string {
  // The three letters must be a code the runtime knows, so a typo does not become a currency.
  if (!Intl.supportedValuesOf('currency').includes(currency)) {
    throw new HttpError(400, 'validation_failed', 'currency is not a known code');
  }
  return currency;
}

export const platformRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { pool } = app.database;
  const limit = { rateLimit: { max: app.config.RATE_LIMIT_USER_PER_MINUTE, timeWindow: 60_000 } };
  const tags = ['platform'];

  /** The modules a hospital can be given: every module that declares permissions, and the switches. */
  const moduleIds = () => [
    ...new Set(app.permissions.all().map((permission) => permission.feature)),
  ];
  const knownModules = () => new Set([...moduleIds(), ...AUTH_SWITCHES]);
  const checkModules = (names: readonly string[]) => {
    const known = knownModules();
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new HttpError(400, 'unknown_feature', `Unknown module: ${unknown.join(', ')}`);
    }
  };

  /**
   * Signs the hospital's staff out. The tenancy hook already refuses a hospital that is not
   * active, so a failure here leaves no one with access: it is logged, and the offboarding job
   * (or a repeat) ends them.
   */
  const closeSessions = (
    hospitalId: string,
    log: { warn: (fields: object, message: string) => void },
  ) =>
    endHospitalSessions(pool, hospitalId).catch(() => {
      log.warn({ event: 'hospital_sessions_not_ended' }, 'sessions not ended');
    });

  const admin = (request: { platformAdmin: { userId: string } | null }) => {
    if (!request.platformAdmin) throw new HttpError(401, 'unauthenticated', 'No session');
    return request.platformAdmin.userId;
  };

  app.post(
    '/platform/hospitals',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformCreateHospital',
        tags,
        description:
          'Onboards a hospital: creates it with its built-in roles and their default permissions, and switches on the modules named. It is created active and has no staff: invite its first admin next (`platformInviteHospitalAdmin`). Requires an Idempotency-Key; a repeat returns the hospital the first request made.',
        headers: RequiredIdempotencyHeaders,
        body: CreateHospitalBody,
        response: { 201: ref(PlatformHospital), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const userId = admin(request);
      const body = request.body;
      const key = request.headers['idempotency-key'];
      checkModules(body.features);
      const values = {
        name: tidyWithin(body.name, 200),
        locale: checkLocale(body.locale),
        timezone: checkTimezone(body.timezone),
        currency: checkCurrency(body.currency),
        address: tidyOptional(text(body.address), 500),
        phone: tidyOptional(text(body.phone), 32),
        registrationNumber: tidyOptional(text(body.registrationNumber), 100),
      };
      const hash = requestHash('hospital.create', body);

      const result = await withPlatformTransaction(pool, async (client) => {
        const prior = await claimKey(client, userId, key, hash);
        if (prior) return { hospital: await getHospital(client, prior), replayed: true };

        let id: string;
        try {
          const { rows } = await client.query<{ id: string }>(
            `insert into tenants (slug, name, locale, timezone, currency, theme_primary,
                                  theme_logo_url, address, phone, registration_number, auth_mode,
                                  region, max_users, storage_mb)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             returning id`,
            [
              body.slug,
              values.name,
              values.locale,
              values.timezone,
              values.currency,
              body.themePrimary,
              body.themeLogoUrl ?? null,
              values.address,
              values.phone,
              values.registrationNumber,
              body.authMode ?? 'password',
              body.region ?? null,
              body.maxUsers ?? null,
              body.storageMb ?? null,
            ],
          );
          const created = rows[0]?.id;
          if (!created) throw new Error('hospital was not created');
          id = created;
        } catch (error) {
          if (isUnique(error, 'tenants_slug_key')) {
            throw new HttpError(409, 'slug_taken', 'A hospital with this slug exists');
          }
          throw error;
        }

        const modules = [...new Set(body.features)];
        if (modules.length > 0) {
          await client.query(
            `insert into tenant_features (tenant_id, feature, enabled)
             select $1, unnest($2::text[]), true`,
            [id, modules],
          );
        }
        // The built-in roles exist from the insert (a trigger); this gives them their permissions.
        await syncRoleDefaults(client, app.permissions.all(), id);
        await rememberKey(client, userId, key, hash, id);
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.create',
          entity: 'hospital',
          entityId: id,
          hospitalId: id,
          detail: { modules: modules.length },
          requestId: request.id,
        });
        return { hospital: await getHospital(client, id), replayed: false };
      });

      if (result.replayed) void reply.header('idempotent-replayed', 'true');
      return reply.status(201).send(result.hospital);
    },
  );

  app.get(
    '/platform/modules',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformListModules',
        tags,
        description:
          'The ids a hospital can be given through `PUT /platform/hospitals/{id}/features` and at creation: every module that declares permissions, and the two authenticator switches (`kind: switch`). Display names are the web app’s. Nothing about any hospital.',
        response: { 200: ref(PlatformModuleList), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      admin(request);
      return {
        items: [
          ...moduleIds()
            .sort()
            .map((id) => ({ id, kind: 'module' as const })),
          ...AUTH_SWITCHES.map((id) => ({ id, kind: 'switch' as const })),
        ],
      };
    },
  );

  app.get(
    '/platform/hospitals',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformListHospitals',
        tags,
        description:
          'Hospitals, newest first, a page at a time. Filter by status, or by part of a name or slug.',
        querystring: ListHospitalsQuery,
        response: { 200: ref(PlatformHospitalPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      admin(request);
      const { cursor, limit: size, status, q } = request.query;
      return withPlatformTransaction(pool, (client) =>
        listHospitals(client, {
          cursor,
          limit: size,
          status: text(status),
          term: searchTerm(text(q)),
        }),
      );
    },
  );

  app.get(
    '/platform/hospitals/:id',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformGetHospital',
        tags,
        description: 'One hospital with its configuration, limits, module flags and head count.',
        params: HospitalParams,
        response: { 200: ref(PlatformHospital), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      admin(request);
      return withPlatformTransaction(pool, (client) => getHospital(client, request.params.id));
    },
  );

  app.patch(
    '/platform/hospitals/:id',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformUpdateHospital',
        tags,
        description:
          'Changes a hospital’s configuration. Send only the fields that changed, with the `version` the edit started from: 409 `version_conflict` when someone saved first. A null clears an optional field. Status and modules have their own routes.',
        params: HospitalParams,
        body: UpdateHospitalBody,
        response: { 200: ref(PlatformHospital), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const userId = admin(request);
      const { id } = request.params;
      const { version, ...changes } = request.body;

      const column: Record<string, string> = {
        name: 'name',
        locale: 'locale',
        timezone: 'timezone',
        currency: 'currency',
        themePrimary: 'theme_primary',
        themeLogoUrl: 'theme_logo_url',
        address: 'address',
        phone: 'phone',
        registrationNumber: 'registration_number',
        authMode: 'auth_mode',
        region: 'region',
        maxUsers: 'max_users',
        storageMb: 'storage_mb',
      };
      const set: string[] = [];
      const values: unknown[] = [id, version];
      for (const [field, value] of Object.entries(changes)) {
        const name = column[field];
        if (name === undefined || value === undefined) continue;
        let stored: unknown = value;
        if (typeof value === 'string') {
          if (field === 'name') stored = tidyWithin(value, 200);
          else if (field === 'locale') stored = checkLocale(value);
          else if (field === 'timezone') stored = checkTimezone(value);
          else if (field === 'currency') stored = checkCurrency(value);
          else if (field === 'address') stored = tidyOptional(value, 500);
          else if (field === 'phone') stored = tidyOptional(value, 32);
          else if (field === 'registrationNumber') stored = tidyOptional(value, 100);
        }
        values.push(stored);
        set.push(`${name} = $${values.length}`);
      }
      if (set.length === 0) {
        throw new HttpError(400, 'validation_failed', 'Nothing to change');
      }

      return withPlatformTransaction(pool, async (client) => {
        const { rowCount } = await client.query(
          `update tenants set ${set.join(', ')}, version = version + 1, updated_at = now()
           where id = $1 and version = $2`,
          values,
        );
        if (rowCount === 0) {
          const current = await findHospital(client, id);
          if (!current) throw new HttpError(404, 'not_found', 'No such hospital');
          throw new HttpError(409, 'version_conflict', 'The hospital was changed by someone else');
        }
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.update',
          entity: 'hospital',
          entityId: id,
          hospitalId: id,
          // Which fields, never their values.
          detail: { fields: Object.keys(changes).sort().join(',') },
          requestId: request.id,
        });
        return getHospital(client, id);
      });
    },
  );

  app.put(
    '/platform/hospitals/:id/features',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformSetHospitalFeatures',
        tags,
        description:
          'Switches modules on or off for a hospital, effective at its staff’s next policy refresh with no redeploy. Modules not named keep their setting. `mfa` offers the authenticator to the hospital’s staff and `mfa_required` (with it) makes it compulsory.',
        params: HospitalParams,
        body: SetFeaturesBody,
        response: { 200: ref(PlatformHospital), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const userId = admin(request);
      const { id } = request.params;
      const { features } = request.body;
      checkModules(features.map((entry) => entry.feature));
      // The last word on a module wins if it is named twice.
      const wanted = new Map(features.map((entry) => [entry.feature, entry.enabled]));

      return withPlatformTransaction(pool, async (client) => {
        if (!(await findHospital(client, id))) {
          throw new HttpError(404, 'not_found', 'No such hospital');
        }
        const changed = await client.query<{ feature: string; enabled: boolean }>(
          `insert into tenant_features (tenant_id, feature, enabled)
           select $1, name, enabled from unnest($2::text[], $3::boolean[]) as t (name, enabled)
           on conflict (tenant_id, feature) do update
             set enabled = excluded.enabled, updated_at = now()
             where tenant_features.enabled is distinct from excluded.enabled
           returning feature, enabled`,
          [id, [...wanted.keys()], [...wanted.values()]],
        );
        for (const { feature, enabled } of changed.rows) {
          await recordPlatformAudit(client, {
            actorId: userId,
            action: enabled ? 'hospital.feature_on' : 'hospital.feature_off',
            entity: 'hospital',
            entityId: id,
            hospitalId: id,
            detail: { feature },
            requestId: request.id,
          });
        }
        return getHospital(client, id);
      });
    },
  );

  app.post(
    '/platform/hospitals/:id/admin-invite',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformInviteHospitalAdmin',
        tags,
        description:
          'Invites the first admin of a hospital. Only while the hospital is active and has no active admin (409 `hospital_has_admin` after that: its admins invite their own staff, and the platform cannot put anyone into a live hospital’s admin role), and never to a platform admin’s address. An earlier open invite to the same address is withdrawn. The link is emailed by a job; the admin sets a password and an authenticator and signs in.',
        params: HospitalParams,
        body: AdminInviteBody,
        response: { 201: ref(PlatformInvite), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const userId = admin(request);
      const { id } = request.params;
      const email = normalizeEmail(request.body.email);
      if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
        throw new HttpError(400, 'validation_failed', 'email is not an address');
      }

      const invite = await withPlatformTransaction(pool, async (client) => {
        const hospital = await getHospital(client, id);
        if (hospital.status !== 'active') {
          throw new HttpError(409, 'hospital_not_active', 'The hospital is not active');
        }
        // Only until the hospital has an admin of its own: after that its admins invite their
        // staff, and nobody on the platform can put themselves in a live hospital's admin role.
        if (await hasActiveAdmin(client, id)) {
          throw new HttpError(409, 'hospital_has_admin', 'The hospital already has an admin');
        }
        if (await isPlatformAdminEmail(client, email)) {
          throw new HttpError(400, 'validation_failed', 'That address belongs to a platform admin');
        }
        const created = await createAdminInvite(client, {
          hospitalId: id,
          email,
          name: tidyWithin(request.body.name, 200),
          invitedBy: userId,
          ttlHours: app.config.INVITE_TTL_HOURS,
        });
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.admin_invited',
          entity: 'invite',
          entityId: created.id,
          hospitalId: id,
          // Enough to trace who was invited without keeping the address.
          detail: {
            domain: email.slice(email.lastIndexOf('@') + 1),
            emailHash: createHash('sha256').update(email).digest('hex').slice(0, 16),
          },
          requestId: request.id,
        });
        return created;
      });

      // After the commit: the job gives the invite its token and sends the link.
      await queueInviteEmail(app.jobs, { tenantId: id, inviteId: invite.id }).catch(() => {
        request.log.warn({ event: 'invite_email_not_queued' }, 'invite email not queued');
      });
      return reply.status(201).send(invite);
    },
  );

  app.get(
    '/platform/hospitals/:id/admin-invites',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformListHospitalAdminInvites',
        tags,
        description:
          'The invites to the hospital that nobody has accepted or withdrawn, newest first (at most 50; an expired one is listed so it can be sent again). Never the token.',
        params: HospitalParams,
        response: { 200: ref(PlatformInvitePage), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const { id } = request.params;
      return withPlatformTransaction(pool, async (client) => {
        await getHospital(client, id);
        return { items: await listOpenInvites(client, id), nextCursor: null };
      });
    },
  );

  app.post(
    '/platform/hospitals/:id/admin-invites/:inviteId/revoke',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformRevokeHospitalAdminInvite',
        tags,
        description:
          'Withdraws an open invite, so its link no longer works. 404 for an invite that is not open at this hospital. To send one again, invite the same address again.',
        params: InviteParams,
        response: { 204: Type.Null(), ...errors(401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const userId = admin(request);
      const { id, inviteId } = request.params;
      await withPlatformTransaction(pool, async (client) => {
        const revoked = await revokeOpenInvite(client, id, inviteId);
        if (!revoked) throw new HttpError(404, 'not_found', 'No such open invite');
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.admin_invite_revoked',
          entity: 'invite',
          entityId: inviteId,
          hospitalId: id,
          requestId: request.id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  /** One status change, from the statuses it may start at. */
  const transition = async (
    client: pg.ClientBase,
    id: string,
    from: readonly PlatformHospital['status'][],
    set: string,
    values: unknown[] = [],
  ): Promise<void> => {
    const { rowCount } = await client.query(
      `update tenants set ${set}, version = version + 1, updated_at = now()
       where id = $1 and status = any($2::text[])`,
      [id, from, ...values],
    );
    if (rowCount === 0) {
      if (!(await findHospital(client, id))) {
        throw new HttpError(404, 'not_found', 'No such hospital');
      }
      throw new HttpError(
        409,
        'invalid_transition',
        'The hospital is not in a status that allows it',
      );
    }
  };

  app.post(
    '/platform/hospitals/:id/suspend',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformSuspendHospital',
        tags,
        description:
          'Blocks all use of the hospital: its staff are signed out and every route of the hospital answers 403 `tenant_suspended`. Its data is kept. Reversible with reactivate.',
        params: HospitalParams,
        response: { 200: ref(PlatformHospital), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const userId = admin(request);
      const { id } = request.params;
      const hospital = await withPlatformTransaction(pool, async (client) => {
        await transition(client, id, ['active'], "status = 'suspended', suspended_at = now()");
        await withdrawOpenInvites(client, id);
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.suspend',
          entity: 'hospital',
          entityId: id,
          hospitalId: id,
          requestId: request.id,
        });
        return getHospital(client, id);
      });
      await closeSessions(id, request.log);
      return hospital;
    },
  );

  app.post(
    '/platform/hospitals/:id/reactivate',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformReactivateHospital',
        tags,
        description:
          'Opens a suspended hospital again, or cancels an offboarding that has not run. Staff sign in again.',
        params: HospitalParams,
        response: { 200: ref(PlatformHospital), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const userId = admin(request);
      const { id } = request.params;
      return withPlatformTransaction(pool, async (client) => {
        await transition(
          client,
          id,
          ['suspended', 'offboarding'],
          `status = 'active', suspended_at = null, offboarding_requested_at = null, delete_after = null`,
        );
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.reactivate',
          entity: 'hospital',
          entityId: id,
          hospitalId: id,
          requestId: request.id,
        });
        return getHospital(client, id);
      });
    },
  );

  app.post(
    '/platform/hospitals/:id/offboard',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformOffboardHospital',
        tags,
        description:
          'Starts offboarding: the hospital is closed to its staff like a suspended one, its open invites are withdrawn, and it is marked for deletion after the given number of days. The export and the deletion itself are not run by the API yet: the data is kept, and reactivate cancels this.',
        params: HospitalParams,
        body: OffboardBody,
        response: { 200: ref(PlatformHospital), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const userId = admin(request);
      const { id } = request.params;
      const hospital = await withPlatformTransaction(pool, async (client) => {
        await transition(
          client,
          id,
          ['active', 'suspended'],
          `status = 'offboarding', offboarding_requested_at = now(),
           delete_after = now() + make_interval(days => $3)`,
          [request.body.deleteAfterDays],
        );
        await withdrawOpenInvites(client, id);
        await recordPlatformAudit(client, {
          actorId: userId,
          action: 'hospital.offboard',
          entity: 'hospital',
          entityId: id,
          hospitalId: id,
          detail: { deleteAfterDays: request.body.deleteAfterDays },
          requestId: request.id,
        });
        return getHospital(client, id);
      });
      // Signed out now; the job checks again for any session that started in between.
      await closeSessions(id, request.log);
      const job: OffboardJob = { hospitalId: id, requestedBy: userId };
      await app.jobs
        .send(OFFBOARD_JOB, job, {
          id: `${OFFBOARD_JOB}:${id}:${randomUUID()}`,
          retryLimit: 5,
          retryDelay: 30,
          retryBackoff: true,
        })
        .catch(() => {
          request.log.warn({ event: 'offboard_job_not_queued' }, 'offboarding job not queued');
        });
      return hospital;
    },
  );

  app.get(
    '/platform/audit',
    {
      config: { access: 'platform', ...limit },
      schema: {
        operationId: 'platformListAudit',
        tags,
        description:
          'What platform admins did, newest first: onboarding, edits, module switches, invites, suspension and offboarding. Ids and codes only, never a field’s value.',
        querystring: AuditQuery,
        response: { 200: ref(PlatformAuditPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      admin(request);
      const { cursor, limit: size, hospitalId, actorId } = request.query;
      return withPlatformTransaction(pool, (client) =>
        listAudit(client, { cursor, limit: size, hospitalId, actorId }),
      );
    },
  );
};
