import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  callAgain,
  callNext,
  departmentOpen,
  departmentsInScope,
  findToken,
  issueToken,
  listTokens,
  patientExists,
  practisingDoctor,
  setPriority,
  setStatus,
  type TokenRow,
  type Visibility,
} from './repository.js';
import {
  QUEUE_SCHEMAS,
  QueueCallNext,
  QueueListQuery,
  QueueToken,
  QueueTokenChange,
  QueueTokenCreate,
  QueueTokenPage,
  QueueTokenParams,
  QueueTokenPriorityChange,
  type QueueTokenStatusValue,
} from './schemas.js';

const FEATURE = 'queue';
const READ = 'queue:read';
const CREATE = 'queue:create';
const CALL = 'queue:call';
const PATIENT_READ = 'patient:read';

/** The bus topic and SSE event a change of a department's queue is announced on. */
export const QUEUE_TOPIC = 'queue';

const notFound = () => new HttpError(404, 'token_not_found', 'No such token');

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const visibilityFor = (request: FastifyRequest, permission: Permission): Visibility => ({
  scope: request.access.scope(permission),
  userId: userIdOf(request),
});

const token = (row: TokenRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  number: row.number,
  day: row.day,
  departmentId: row.department_id,
  departmentName: row.department_name,
  ...(row.doctor_id === null ? {} : { doctorId: row.doctor_id }),
  ...(row.doctor_name === null ? {} : { doctorName: row.doctor_name }),
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  status: row.status,
  ...(row.priority === null ? {} : { priority: row.priority }),
  issuedAt: row.issued_at.toISOString(),
  ...(row.called_at === null ? {} : { calledAt: row.called_at.toISOString() }),
  callCount: row.call_count,
  version: row.version,
});

/** The refusal for a token the unique indexes turned down, or the error itself. */
function issueRefusal(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === '23505' && constraint === 'queue_tokens_one_open') {
    return new HttpError(409, 'already_queued', 'The patient is already in this queue');
  }
  return error;
}

const CHANGE_RULES =
  ' The `version` must be the current one, or 409 `conflict`; a change the status does not allow is 409 `invalid_transition`. Enforced on the locked row, in the same transaction as the change. A token of another hospital, of another day, or outside the scope the caller holds `queue:call` with, answers 404 `token_not_found`, the same as one that does not exist. The Idempotency-Key header is required: the same key changes nothing again and answers with the token as it is now. Audited, and announced on `/queue/events`.';

export const queueRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of QUEUE_SCHEMAS) app.addSchema(schema);

  /** Tells the hospital's open boards that a department's queue changed, once this commits. */
  const announce = (request: FastifyRequest, departmentId: string) =>
    app.live.bus.publish(request.txClient, QUEUE_TOPIC, { departmentId });

  app.get(
    '/queue/tokens',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listQueueTokens',
        tags: ['queue'],
        description:
          'Today’s tokens at the hospital (its own calendar day, worked out by the server) of one status, in call order: for `waiting` and `skipped` the priority ones first, then by the time they were issued, the number breaking a tie; for `called` and `served` in the order they were called. With `doctorId`, the doctor’s queue: the tokens issued for that doctor and the tokens of the doctor’s department issued for no doctor, which is what call-next takes from. A list, not a search: nothing in its address is typed about a patient, so it is a GET. Each row names its patient (name and MRN) for anyone who may read the queue. The scope of the caller’s `queue:read` is applied whatever the filters say: `department`, the tokens of the department of the caller’s doctor profile; `own`, the caller’s own queue. Requires queue:read and the queue feature flag. Names patients, so every row of a page read is audited. `total` comes with the first page only.',
        querystring: QueueListQuery,
        response: { 200: ref(QueueTokenPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { status, departmentId, doctorId, cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listTokens(
        request.txClient,
        {
          status: status as QueueTokenStatusValue,
          ...(departmentId === undefined ? {} : { departmentId }),
          ...(doctorId === undefined ? {} : { doctorId }),
          ...(cursor === undefined ? {} : { cursor }),
          limit,
        },
        visibilityFor(request, READ),
      );
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'queue_token', row.id);
      return {
        items: page.rows.map(token),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/queue/tokens',
    {
      // The answer names the patient: only the new id is kept for a repeat.
      config: {
        permissions: [CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'issueQueueToken',
        tags: ['queue'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Issues today’s next token of a department to a patient, optionally for one practising doctor of that department (422 `doctor_not_in_department` otherwise) and with a priority. The number is given by the server, one sequence per department per calendar day at the hospital: a counter row per department and day is locked while the token is issued, so two desks issuing at once get consecutive numbers, and a refused token gives its number back. A patient with a token still waiting, called or skipped in that department today is refused (409 `already_queued`, decided by a unique index). An unknown or archived department is 422 `unknown_department`. Requires queue:create and patient:read: a role that may not read patients learns nothing about one here, as an unknown patient and a patient it may not read are both 422 `unknown_patient`. The Idempotency-Key header is required: a repeat issues nothing and answers with the token as it is now. Audited, emits `queue.token_issued` through the outbox, and is announced on `/queue/events`.',
        body: ref(QueueTokenCreate),
        response: { 201: ref(QueueToken), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const visibility = visibilityFor(request, CREATE);
      if (request.replayOf !== null) {
        const issued = request.idempotentId
          ? await findToken(request.txClient, request.idempotentId, { scope: 'all', userId: '' })
          : null;
        if (!issued) throw notFound();
        request.audit('read', 'queue_token', issued.id);
        return reply.status(201).send(token(issued));
      }
      const body = request.body as QueueTokenCreate;
      const policy = await request.access.policy();
      const readsPatients = policy?.permissions.some((grant) => grant.permission === PATIENT_READ);
      if (!readsPatients || !(await patientExists(request.txClient, body.patientId))) {
        throw new HttpError(422, 'unknown_patient', 'No such patient');
      }
      if (!(await departmentOpen(request.txClient, body.departmentId))) {
        throw new HttpError(422, 'unknown_department', 'No such department');
      }
      // Issued only where the caller's scope of `queue:create` reaches.
      const reach = await departmentsInScope(request.txClient, visibility);
      if (reach && !reach.has(body.departmentId)) {
        throw new HttpError(422, 'unknown_department', 'No such department');
      }
      let doctorId: string | null = null;
      if (body.doctorId !== undefined) {
        const doctor = await practisingDoctor(request.txClient, body.doctorId);
        if (!doctor || doctor.department_id !== body.departmentId) {
          throw new HttpError(422, 'doctor_not_in_department', 'Not a doctor of this department');
        }
        doctorId = doctor.id;
      }
      let id: string;
      try {
        id = await issueToken(
          request.txClient,
          {
            patientId: body.patientId,
            departmentId: body.departmentId,
            doctorId,
            priority: body.priority ?? null,
          },
          userIdOf(request),
        );
      } catch (error) {
        throw issueRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'queue_token', id);
      const issued = await findToken(request.txClient, id, { scope: 'all', userId: '' });
      if (!issued) throw notFound();
      await request.emit('queue.token_issued', id, {
        tokenId: id,
        patientId: issued.patient_id,
        departmentId: issued.department_id,
        doctorId: issued.doctor_id,
        number: issued.number,
        day: issued.day,
      });
      await announce(request, issued.department_id);
      return reply.status(201).send(token(issued));
    },
  );

  app.post(
    '/queue/call-next',
    {
      config: {
        permissions: [CALL],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'callNextQueueToken',
        tags: ['queue'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Calls the next token of a doctor’s queue (see listQueueTokens), the first in call order, and gives it to the doctor; the token the doctor was serving becomes `served`. Calls for one doctor wait for each other, and two doctors of a department calling at the same moment never get the same token (the candidate is locked and one already locked is passed over). Nobody waiting is 409 `queue_empty`, and then nothing changes: the doctor goes on serving the same patient. A doctor who does not practise here, or outside the scope the caller holds queue:call with (`own`: the caller’s own profile; `department`: a doctor of the caller’s department), is 422 `unknown_doctor`. Requires queue:call. The Idempotency-Key header is required: a repeat calls nobody else and answers with the token it called, as it is now. Audited, emits `queue.called` through the outbox, and is announced on `/queue/events`.',
        body: QueueCallNext,
        response: { 200: ref(QueueToken), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const called = request.idempotentId
          ? await findToken(request.txClient, request.idempotentId, { scope: 'all', userId: '' })
          : null;
        if (!called) throw notFound();
        request.audit('read', 'queue_token', called.id);
        return reply.status(200).send(token(called));
      }
      const body = request.body as QueueCallNext;
      const doctor = await practisingDoctor(
        request.txClient,
        body.doctorId,
        visibilityFor(request, CALL),
      );
      if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');
      const result = await callNext(request.txClient, doctor);
      if (!result) throw new HttpError(409, 'queue_empty', 'Nobody is waiting');
      if (result.served) request.audit('update', 'queue_token', result.served);
      request.audit('update', 'queue_token', result.called);
      request.idempotentId = result.called;
      const called = await findToken(request.txClient, result.called, { scope: 'all', userId: '' });
      if (!called) throw notFound();
      await request.emit('queue.called', called.id, {
        tokenId: called.id,
        patientId: called.patient_id,
        departmentId: called.department_id,
        doctorId: doctor.id,
        callCount: called.call_count,
        ...(result.served ? { servedTokenId: result.served } : {}),
      });
      await announce(request, called.department_id);
      return reply.status(200).send(token(called));
    },
  );

  /**
   * The shape every change of one token shares: a repeat answers with the token as it is now;
   * otherwise the row is locked, found within the caller's scope of `queue:call`, must be today's,
   * at the version the change was made from and in a status that allows it, and `change` does
   * the rest.
   */
  async function changeToken(
    request: FastifyRequest<{ Params: { tokenId: string } }>,
    reply: FastifyReply,
    version: number,
    from: readonly QueueTokenStatusValue[],
    change: (row: TokenRow) => Promise<void>,
  ) {
    const visibility = visibilityFor(request, CALL);
    const id = request.params.tokenId;
    if (request.replayOf === null) {
      const row = await findToken(request.txClient, id, visibility, { forUpdate: true });
      if (!row || !(await isToday(request, row.day))) throw notFound();
      if (row.version !== version) {
        throw new HttpError(409, 'conflict', 'The token has changed since it was read');
      }
      if (!from.includes(row.status)) {
        throw new HttpError(409, 'invalid_transition', `Not from ${row.status}`);
      }
      await change(row);
      request.audit('update', 'queue_token', row.id);
      await announce(request, row.department_id);
    }
    const now = await findToken(request.txClient, id, visibility);
    if (!now) throw notFound();
    if (request.replayOf !== null) request.audit('read', 'queue_token', now.id);
    return reply.status(200).send(token(now));
  }

  async function isToday(request: FastifyRequest, day: string): Promise<boolean> {
    const { rows } = await request.txClient.query<{ today: boolean }>(
      `select $1::date = (now() at time zone timezone)::date as today
       from tenants where id = app_tenant_id()`,
      [day],
    );
    return rows[0]?.today === true;
  }

  const changeSchema = (
    operationId: string,
    description: string,
    body: typeof QueueTokenChange | typeof QueueTokenPriorityChange,
  ) => ({
    operationId,
    tags: ['queue'],
    description: description + CHANGE_RULES,
    headers: RequiredIdempotencyHeaders,
    params: QueueTokenParams,
    body,
    response: { 200: ref(QueueToken), ...errors(400, 401, 403, 404, 409, 422, 429) },
  });

  const changeConfig = {
    permissions: [CALL],
    feature: FEATURE,
    idempotent: { body: 'none', required: true },
  } as const;

  app.post(
    '/queue/tokens/:tokenId/call-again',
    {
      config: changeConfig,
      schema: changeSchema(
        'callQueueTokenAgain',
        'Calls the token being served again, when the patient has not come in: its call count goes up. Only a `called` token. Requires queue:call. Emits `queue.called` through the outbox.',
        QueueTokenChange,
      ),
    },
    async (request, reply) => {
      const body = request.body as QueueTokenChange;
      return changeToken(request, reply, body.version, ['called'], async (row) => {
        await callAgain(request.txClient, row.id);
        await request.emit('queue.called', row.id, {
          tokenId: row.id,
          patientId: row.patient_id,
          departmentId: row.department_id,
          doctorId: row.doctor_id,
          callCount: row.call_count + 1,
        });
      });
    },
  );

  for (const [path, operationId, from, to, description] of [
    [
      'skip',
      'skipQueueToken',
      ['called'],
      'skipped',
      'The patient called did not come: the token is put aside as `skipped`, and keeps its doctor. Only a `called` token. Requires queue:call.',
    ],
    [
      'recall',
      'recallQueueToken',
      ['skipped'],
      'waiting',
      'A skipped patient has come back: the token waits again, at the place its priority and the time it was issued give it, in the queue of the doctor who called it. Only a `skipped` token. Requires queue:call.',
    ],
  ] as const) {
    app.post(
      `/queue/tokens/:tokenId/${path}`,
      { config: changeConfig, schema: changeSchema(operationId, description, QueueTokenChange) },
      async (request, reply) => {
        const body = request.body as QueueTokenChange;
        return changeToken(request, reply, body.version, from, (row) =>
          setStatus(request.txClient, row.id, to),
        );
      },
    );
  }

  app.post(
    '/queue/tokens/:tokenId/priority',
    {
      config: changeConfig,
      schema: changeSchema(
        'setQueueTokenPriority',
        'Sets or clears the reason a token goes ahead of the others (null clears it). Only a `waiting` or `skipped` token. Requires queue:call.',
        QueueTokenPriorityChange,
      ),
    },
    async (request, reply) => {
      const body = request.body as QueueTokenPriorityChange;
      return changeToken(request, reply, body.version, ['waiting', 'skipped'], (row) =>
        setPriority(request.txClient, row.id, body.priority),
      );
    },
  );

  app.get(
    '/queue/events',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'queueEvents',
        tags: ['queue'],
        description:
          'Server-sent events for the queues of the session’s hospital, and of no other. Each `queue` event says only which department’s queue changed (`data: {"departmentId":"..."}`), never who: the screen then reads the queue again through listQueueTokens, which is audited. Under a `queue:read` scope of `department` or `own`, only the caller’s department’s events are sent. The stream opens with a `retry:` line and holds no database connection while open; a comment line is sent every 20 seconds to keep the connection open, and a client takes 45 seconds without anything as a lost connection. The server ends the stream when the session ends, is revoked, goes idle or switches hospital, and when the session loses queue:read or the hospital the queue switch or is suspended, checking all of these again at each keep-alive and before sending events (a check made in the last two seconds is reused for a burst). It also ends the stream when it may have missed changes, so the screen opens it again and reads the queue. 503 `live_unavailable` when live updates cannot be followed now: the screen reads the queue on a timer instead. Requires queue:read and the queue feature flag.',
        produces: ['text/event-stream'],
        response: {
          200: Type.String({ description: 'An event stream that stays open' }),
          ...errors(401, 403, 409, 429, 503),
        },
      },
    },
    async (request, reply) => {
      await app.live.stream(request, reply, {
        topic: QUEUE_TOPIC,
        event: 'queue',
        async filter(client, policy, userId) {
          const scope =
            policy.permissions.find((grant) => grant.permission === READ)?.scope ?? 'all';
          const reach = await departmentsInScope(client, { scope, userId });
          return (data) =>
            typeof data.departmentId === 'string' && (!reach || reach.has(data.departmentId));
        },
      });
    },
  );
};
