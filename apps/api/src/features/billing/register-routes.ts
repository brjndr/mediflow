import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { CursorQuery, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  closeSession,
  collectedOn,
  findSession,
  insertSession,
  listSessions,
  lockSession,
  num,
  openSessionOf,
} from './repository.js';
import {
  Collected,
  CollectedQuery,
  NOTE_MAX,
  RegisterClose,
  RegisterOpen,
  RegisterSession,
  RegisterSessionPage,
} from './schemas.js';
import { FEATURE, requireAll, sessionView, userIdOf } from './views.js';

const SessionParams = Type.Object({ sessionId: Type.String({ maxLength: 64 }) });
const sessionNotFound = () => new HttpError(404, 'session_not_found', 'No such register session');

/**
 * Cash register sessions and the day-end settlement (#114). A person opens one with the cash in
 * the drawer; cash payments and refunds they record go into it; they close it with the cash
 * counted, and the server works out what was expected and keeps the difference. A closed session
 * is never changed.
 */
export const registerRoutes: FastifyPluginAsyncTypebox = async (app) => {
  async function answer(request: FastifyRequest, id: string) {
    const row = await findSession(request.txClient, id);
    if (!row) throw sessionNotFound();
    request.audit('read', 'cash_register_session', row.id);
    return sessionView(row);
  }

  app.post(
    '/cash-registers/sessions',
    {
      config: {
        permissions: ['cashRegister:manage'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'openRegisterSession',
        tags: ['billing'],
        description:
          'Opens the caller’s cash register session with the cash in the drawer (#114). A person has one open at a time (409 `register_open`). The Idempotency-Key header is required. Requires cashRegister:manage with the scope `all` and the billing feature flag. Audited.',
        headers: RequiredIdempotencyHeaders,
        body: ref(RegisterOpen),
        response: { 201: ref(RegisterSession), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply: FastifyReply) => {
      requireAll(request, 'cashRegister:manage');
      if (request.replayOf !== null) {
        if (!request.idempotentId) throw sessionNotFound();
        return reply.status(201).send(await answer(request, request.idempotentId));
      }
      const userId = userIdOf(request);
      if (await openSessionOf(request.txClient, userId)) {
        throw new HttpError(409, 'register_open', 'A session is already open');
      }
      const id = randomUUID();
      try {
        await insertSession(request.txClient, {
          id,
          by: userId,
          openingMinor: (request.body as { openingMinor: number }).openingMinor,
        });
      } catch (error) {
        // Two requests of one person at once: the index lets one in.
        const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
        if (code === '23505' && constraint === 'cash_register_sessions_one_open') {
          throw new HttpError(409, 'register_open', 'A session is already open');
        }
        throw error;
      }
      request.idempotentId = id;
      request.audit('create', 'cash_register_session', id);
      return reply.status(201).send(await answer(request, id));
    },
  );

  app.get(
    '/cash-registers/sessions/current',
    {
      config: { permissions: ['cashRegister:manage'], feature: FEATURE },
      schema: {
        operationId: 'getOpenRegisterSession',
        tags: ['billing'],
        description:
          'The cash register session the caller has open, with what it holds so far (#114); 404 `session_not_found` when none. Requires cashRegister:manage with the scope `all` and the billing feature flag. Audited.',
        response: { 200: ref(RegisterSession), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'cashRegister:manage');
      const open = await openSessionOf(request.txClient, userIdOf(request));
      if (!open) throw sessionNotFound();
      request.audit('read', 'cash_register_session', open.id);
      return sessionView(open);
    },
  );

  app.get(
    '/cash-registers/sessions',
    {
      config: { permissions: ['cashRegister:read'], feature: FEATURE },
      schema: {
        operationId: 'listRegisterSessions',
        tags: ['billing'],
        description:
          'Cash register sessions, newest first, with what each took by method and, once settled, the difference (#114). Requires cashRegister:read with the scope `all` and the billing feature flag. Audited.',
        querystring: CursorQuery,
        response: { 200: ref(RegisterSessionPage), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'cashRegister:read');
      const page = await listSessions(
        request.txClient,
        request.query as { cursor?: string; limit: number },
      );
      if (!page) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
      request.audit('read', 'cash_register_session');
      return {
        items: page.rows.map(sessionView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.get(
    '/cash-registers/collected',
    {
      config: { permissions: ['cashRegister:read'], feature: FEATURE },
      schema: {
        operationId: 'getCollectedOnDate',
        tags: ['billing'],
        description:
          'Payments and refunds of invoices recorded on a calendar date at the hospital’s clock (today when `date` is left out), by method, in minor units (#726). Taken from the payments themselves, not from register sessions; deposits of a stay are not counted. Amounts only, no patient. Requires cashRegister:read with the scope `all` and the billing feature flag. Audited.',
        querystring: CollectedQuery,
        response: { 200: ref(Collected), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'cashRegister:read');
      const { date } = request.query as { date?: string };
      let result;
      try {
        result = await collectedOn(request.txClient, date);
      } catch (error) {
        const { code } = (error ?? {}) as { code?: string };
        if (code === '22008' || code === '22007') {
          throw new HttpError(400, 'invalid_date', 'The date is not valid');
        }
        throw error;
      }
      request.audit('read', 'cash_register_session');
      const totals = result.totals.map((row) => ({
        method: row.method as 'cash' | 'card' | 'upi' | 'bank' | 'other',
        paidMinor: num(row.paid),
        refundedMinor: num(row.refunded),
      }));
      return {
        date: result.date,
        timezone: result.timezone,
        totals,
        netMinor: totals.reduce((sum, each) => sum + each.paidMinor - each.refundedMinor, 0),
      };
    },
  );

  app.get(
    '/cash-registers/sessions/:sessionId',
    {
      config: { permissions: ['cashRegister:read'], feature: FEATURE },
      schema: {
        operationId: 'getRegisterSession',
        tags: ['billing'],
        description:
          'One cash register session (#114). Requires cashRegister:read with the scope `all` and the billing feature flag. Audited.',
        params: SessionParams,
        response: { 200: ref(RegisterSession), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'cashRegister:read');
      return answer(request, (request.params as { sessionId: string }).sessionId);
    },
  );

  app.post(
    '/cash-registers/sessions/:sessionId/close',
    {
      config: {
        permissions: ['cashRegister:manage'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'closeRegisterSession',
        tags: ['billing'],
        description:
          'Settles the caller’s own session at the end of the day (#114): the cash counted is kept with what the server expected (the opening cash and the cash taken, less cash refunded), and the session is final. Another person’s session is not found (404); one already closed is refused (409 `register_closed`). Emits `register.closed`. The Idempotency-Key header is required. Requires cashRegister:manage with the scope `all` and the billing feature flag. Audited.',
        params: SessionParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(RegisterClose),
        response: { 200: ref(RegisterSession), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'cashRegister:manage');
      const { sessionId } = request.params as { sessionId: string };
      if (request.replayOf !== null) return answer(request, sessionId);
      const body = request.body as RegisterClose;
      const client = request.txClient;
      const userId = userIdOf(request);
      // Held, so a payment recorded while it is settled waits and then finds it closed.
      const found = await findSession(client, sessionId);
      if (!found || found.opened_by !== userId) throw sessionNotFound();
      await lockSession(client, found.id);
      const session = await findSession(client, found.id);
      if (!session) throw sessionNotFound();
      if (session.closed_at) {
        throw new HttpError(409, 'register_closed', 'The session is already settled');
      }
      await closeSession(client, {
        id: session.id,
        by: userId,
        expectedMinor: num(session.expected_minor),
        countedMinor: body.countedMinor,
        note: tidyOptional(body.note, NOTE_MAX),
      });
      request.idempotentId = session.id;
      request.audit('update', 'cash_register_session', session.id);
      await request.emit('register.closed', session.id, { sessionId: session.id });
      return answer(request, session.id);
    },
  );
};
