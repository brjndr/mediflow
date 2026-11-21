import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import fp from 'fastify-plugin';
import { insertAuditEntries } from '../audit/plugin.js';
import { HttpError } from '../http/errors.js';
import { errors, ref } from '../http/schemas.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
import { withAuthTransaction } from './db.js';
import { switchTenant } from './sessions.js';
import { loadSessionView, Session } from './session-view.js';

/**
 * Deep links (#1089): `/open/<kind>/<id>` in the web app asks `POST /session/open-link` which
 * hospital owns the record, and the session moves there when the user is an active member of it.
 *
 * A feature makes a kind linkable with `app.links.register(kind, ownerFunction)`, naming a database
 * function that returns the hospital of an id of that kind or nothing. The function belongs to the
 * role `mediflow_link`, which reads only ids and hospitals, and only the auth role may run it
 * (migration 0155, `patient_link_owner`). The record itself is then read through its own route,
 * whose guard, permissions and audit apply as always.
 */
export interface LinkKinds {
  register(kind: string, ownerFunction: string): void;
  ownerFunction(kind: string): string | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The kinds of record a deep link can open. Features add theirs as they register. */
    links: LinkKinds;
  }
}

const KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const SQL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A hospital id no hospital has: the membership check runs against it when no record was found,
// so the answer takes as long whether an id exists somewhere or not.
const NO_HOSPITAL = '00000000-0000-0000-0000-000000000000';

export const linkKindsPlugin = fp(
  async (app) => {
    const kinds = new Map<string, string>();
    app.decorate('links', {
      register(kind: string, ownerFunction: string) {
        if (!KIND.test(kind)) throw new Error(`Link kind ${kind} is not a valid name`);
        // The name is put into SQL, so only a plain identifier is accepted.
        if (!SQL_NAME.test(ownerFunction)) {
          throw new Error(`Link kind ${kind}: ${ownerFunction} is not a function name`);
        }
        if (kinds.has(kind)) throw new Error(`Link kind ${kind} is registered twice`);
        kinds.set(kind, ownerFunction);
      },
      ownerFunction: (kind: string) => kinds.get(kind),
    });
  },
  { name: 'link-kinds' },
);

/** Every refusal, whatever the reason: no such kind or record, or not a member of its hospital. */
const UNAVAILABLE = () => new HttpError(403, 'link_unavailable', 'This link is not available');

export const openLinkRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const pool = app.database.pool;
  const config = app.config;

  app.post(
    '/session/open-link',
    {
      config: { access: 'session' },
      schema: {
        operationId: 'openLink',
        tags: ['auth'],
        description:
          'Opens a deep link to a record by its globally unique id. The server finds the hospital that owns the record, checks that the user is an active member of it, and rebinds the session to that hospital if another one is active (the cookie is replaced). Every refusal is the same 403 link_unavailable, whether the kind is unknown, the record does not exist or belongs to a hospital the user does not work at, so a link cannot be used to find out what exists. The open is recorded in the owning hospital audit log; the record is then read through its own route.',
        body: Type.Object({
          kind: Type.String({
            minLength: 1,
            maxLength: 32,
            description: 'The kind of record, e.g. patient.',
          }),
          id: Type.String({ minLength: 1, maxLength: 64 }),
        }),
        response: { 200: ref(Session), ...errors(400, 401, 403, 429) },
      },
    },
    async (request, reply) => {
      const sessionId = request.session?.id;
      if (!request.session || !sessionId) {
        throw new HttpError(401, 'unauthenticated', 'No session');
      }
      const session = { ...request.session, id: sessionId };
      const { kind, id } = request.body;
      const ownerFunction = app.links.ownerFunction(kind);
      // Kinds and the id format are public, so refusing these at once tells nothing.
      // A refusal is logged as a fixed event, with nothing about the link (no kind, id or
      // hospital), so a session probing with links shows in the logs without saying what exists.
      const refuse = () => {
        request.log.warn({ event: 'open_link_refused' }, 'link not available');
        return UNAVAILABLE();
      };
      if (!ownerFunction || !UUID.test(id)) throw refuse();

      const result = await withAuthTransaction(pool, async (transaction) => {
        await transaction.identify(session.userId);
        const { rows } = await transaction.client.query<{ tenant_id: string | null }>(
          `select ${ownerFunction}($1::uuid) as tenant_id`,
          [id],
        );
        const owner = rows[0]?.tenant_id ?? null;
        // Already there: the session's own hospital, which the session check has just confirmed.
        if (owner !== null && owner === session.tenantId) {
          return {
            owner,
            token: null,
            view: await loadSessionView(transaction.client, session.userId, owner, config),
          };
        }
        const switched = await switchTenant(transaction, session, owner ?? NO_HOSPITAL);
        if (!owner || !switched) return null;
        return {
          owner,
          token: switched.token,
          view: await loadSessionView(transaction.client, session.userId, owner, config),
        };
      });
      if (!result) throw refuse();

      // The session has moved: the new cookie must reach the browser whatever happens next, since
      // the old token stops working 30 seconds after a rotation.
      if (result.token) app.auth.setSessionCookie(reply, result.token);
      // Who opened which record, in the hospital that owns it, ids only. Opening reads no record
      // (its own route, audited as always, does), so a failed entry is logged and not an error, as
      // with the denied-attempt entries.
      try {
        await withTenantTransaction(pool, result.owner, (client) =>
          insertAuditEntries(client, session.userId, request.id, [
            { action: 'open_link', entity: kind, entityId: id },
          ]),
        );
      } catch {
        request.log.warn({ event: 'audit_open_link_failed' }, 'could not record a link opened');
      }
      void reply.header('cache-control', 'no-store');
      return result.view;
    },
  );
};
