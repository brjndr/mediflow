import fp from 'fastify-plugin';
import { HttpError } from '../http/errors.js';
import { ACCESS_SCHEMAS, loadPolicy, type AccessPolicy } from './policy.js';
import {
  createPermissionRegistry,
  PermissionRegistryError,
  type Permission,
  type PermissionRegistry,
  type PermissionScope,
} from './registry.js';

/** What a handler can ask about the caller's access. */
export interface RequestAccess {
  /** The caller's effective policy at the active hospital. Loaded once per request. */
  policy(): Promise<AccessPolicy | null>;
  /**
   * The scope the caller holds a permission with: everything, their own records, or their
   * department's. A handler that reads data must narrow its query by this; the guard has only
   * established that the caller holds the permission at all. Throws for a permission the route
   * did not declare, which would always be a mistake.
   */
  scope(permission: Permission): PermissionScope;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every permission the API knows. Features add theirs when they are registered. */
    permissions: PermissionRegistry;
  }
  interface FastifyRequest {
    access: RequestAccess;
  }
  interface FastifyContextConfig {
    /**
     * What the caller must hold, all of them. Every tenant route states this: `[]` means any
     * active member of the hospital. Leaving it out stops the app from starting.
     */
    permissions?: readonly Permission[];
    /** The hospital module this route belongs to. Off for the hospital means 403. */
    feature?: string;
  }
}

/**
 * The access guard. Runs after the session and tenancy hooks, inside the hospital's transaction,
 * and refuses the request unless the hospital has the route's module switched on and the
 * caller's role there holds every permission the route declares.
 *
 * Two mistakes are caught when the app starts instead of at request time:
 *   - a tenant route that declares no `permissions` (an unlisted route is denied, loudly);
 *   - a route that requires a permission no feature has registered (a typo).
 */
export const accessPlugin = fp(
  async (app) => {
    const registry = createPermissionRegistry();
    app.decorate('permissions', registry);
    for (const schema of ACCESS_SCHEMAS) app.addSchema(schema);

    const required: { route: string; permissions: readonly Permission[] }[] = [];

    app.addHook('onRoute', (route) => {
      const access = route.config?.access ?? 'tenant';
      if (access !== 'tenant') return;
      const label = `${String(route.method)} ${route.url}`;
      if (route.config?.permissions === undefined) {
        throw new Error(
          `${label} is a tenant route without \`config.permissions\`. State what it requires ([] for any member of the hospital).`,
        );
      }
      required.push({ route: label, permissions: route.config.permissions });
    });

    app.addHook('onReady', async () => {
      const problems = required.flatMap(({ route, permissions }) =>
        permissions
          .filter((permission) => !registry.has(permission))
          .map((permission) => `${route} requires "${permission}", which no feature declares`),
      );
      if (problems.length > 0) throw new PermissionRegistryError([...new Set(problems)]);
    });

    // Replaced per request below. This is what a route outside a hospital would see.
    app.decorateRequest('access', {
      getter(): RequestAccess {
        throw new Error('request.access is only available on tenant routes');
      },
    });

    app.addHook('preHandler', async (request) => {
      const { access = 'tenant', permissions = [], feature } = request.routeOptions.config;
      if (access !== 'tenant' || request.is404) return;
      const { session, tenant } = request;
      if (!session || !tenant) throw new HttpError(401, 'unauthenticated', 'No session');

      let loaded: Promise<AccessPolicy | null> | undefined;
      let granted: AccessPolicy['permissions'] = [];
      const policy = () => (loaded ??= loadPolicy(request.txClient, tenant.id, session.userId));

      Object.defineProperty(request, 'access', {
        configurable: true,
        value: {
          policy,
          scope(permission) {
            if (!permissions.includes(permission)) {
              throw new Error(`${request.routeOptions.url} does not declare ${permission}`);
            }
            return granted.find((grant) => grant.permission === permission)?.scope ?? 'all';
          },
        } satisfies RequestAccess,
      });

      // A route open to every member needs no lookup.
      if (permissions.length === 0 && feature === undefined) return;

      const current = await policy();
      if (!current) throw new HttpError(403, 'permission_denied', 'Not a member of this hospital');
      if (feature !== undefined && current.features[feature] !== true) {
        throw new HttpError(403, 'feature_disabled', `Module ${feature} is off for this hospital`);
      }
      granted = current.permissions;
      const missing = permissions.find(
        (permission) => !granted.some((grant) => grant.permission === permission),
      );
      if (missing) throw new HttpError(403, 'permission_denied', `Missing ${missing}`);
    });
  },
  { name: 'access', dependencies: ['session', 'tenancy'] },
);
