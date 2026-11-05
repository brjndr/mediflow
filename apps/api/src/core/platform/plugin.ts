import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { withAuthTransaction } from '../auth/db.js';
import { HttpError } from '../http/errors.js';

export interface PlatformAdmin {
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in platform admin. Set on routes with `access: 'platform'`. */
    platformAdmin: PlatformAdmin | null;
  }
}

/**
 * Routes with `access: 'platform'` are for the product's operators. The caller must be an active
 * user flagged as a platform admin **and** have confirmed an authenticator: without one the
 * answer is 403 `mfa_required` (setting one up is a session route, so it stays within reach). A
 * user who is not a platform admin gets 403 `forbidden`, the same whether or not the route exists
 * for anyone, and a hospital's staff never reach these routes whatever permissions their role has.
 *
 * A platform route never opens a tenant transaction (see core/tenancy) and never has
 * `request.tx`; its database work goes through `withPlatformTransaction`.
 */
export const platformPlugin = fp(
  async (app) => {
    app.decorateRequest('platformAdmin', null);

    app.addHook('preHandler', async (request: FastifyRequest) => {
      if (request.routeOptions.config.access !== 'platform' || request.is404) return;
      const session = request.session;
      if (!session) throw new HttpError(401, 'unauthenticated', 'No session');

      const standing = await withAuthTransaction(app.database.pool, async (transaction) => {
        await transaction.identify(session.userId);
        const { rows } = await transaction.client.query<{
          is_platform_admin: boolean;
          mfa: boolean;
        }>(
          `select u.is_platform_admin,
                  exists (select from user_mfa m where m.user_id = u.id and m.confirmed_at is not null) as mfa
           from users u where u.id = $1 and u.status = 'active'`,
          [session.userId],
        );
        return rows[0];
      });

      if (!standing?.is_platform_admin) {
        throw new HttpError(403, 'forbidden', 'Platform administrators only');
      }
      if (!standing.mfa) {
        throw new HttpError(403, 'mfa_required', 'Platform administrators need an authenticator');
      }
      request.platformAdmin = { userId: session.userId };
    });
  },
  { name: 'platform', dependencies: ['db', 'session', 'auth'] },
);
