import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  errors,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { patientInScope } from '../patients/index.js';

/**
 * Requests to correct a patient's record (#556). A correction is a request with its author and
 * reason, never a silent edit: a second person approves or rejects it with a reason, once. The
 * request does not change the record; the owning module applies an approved one through its own
 * amendment flow, reacting to `correction.approved`.
 */
const FEATURE = 'records';
const READ = 'correction:read';
const REQUEST = 'correction:request';
const DECIDE = 'correction:decide';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Id = Type.String({ format: 'uuid' });
const Kind = StringEnum(['patient', 'encounter', 'document']);
const Status = StringEnum(['pending', 'approved', 'rejected']);

export const CorrectionRequest = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    targetKind: Kind,
    targetId: Type.Optional(Type.String({ description: 'Absent for the patient record itself.' })),
    proposed: Type.String({ description: 'What should be changed, and to what.' }),
    reason: Type.String(),
    status: Status,
    requestedBy: Type.String(),
    requestedAt: Type.String({ format: 'date-time' }),
    decidedBy: Type.Optional(Type.String()),
    decidedAt: Type.Optional(Type.String({ format: 'date-time' })),
    decisionReason: Type.Optional(Type.String()),
    version: Type.Integer(),
  },
  { $id: 'CorrectionRequest', description: 'A request to correct a patient’s record.' },
);
export const CorrectionRequestPage = CursorPage(ref(CorrectionRequest), {
  $id: 'CorrectionRequestPage',
});
export const CorrectionRequestCreate = Type.Object(
  {
    targetKind: Kind,
    targetId: Type.Optional(Id),
    proposed: Type.String({ minLength: 1, maxLength: 1000, pattern: PLAIN_TEXT }),
    reason: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
  },
  { $id: 'CorrectionRequestCreate', additionalProperties: false },
);
type CorrectionRequestCreate = Static<typeof CorrectionRequestCreate>;
export const CorrectionRequestDecide = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
    expectedVersion: Type.Integer({ minimum: 1 }),
  },
  { $id: 'CorrectionRequestDecide', additionalProperties: false },
);
type CorrectionRequestDecide = Static<typeof CorrectionRequestDecide>;

export const CORRECTION_SCHEMAS = [
  CorrectionRequest,
  CorrectionRequestPage,
  CorrectionRequestCreate,
  CorrectionRequestDecide,
] as const;

const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  status: Type.Optional(Status),
});
type ListQuery = Static<typeof ListQuery>;
const PatientParams = Type.Object({ patientId: Id });
const RequestParams = Type.Object({ requestId: Id });

interface Row {
  id: string;
  patient_id: string;
  target_kind: 'patient' | 'encounter' | 'document';
  target_id: string | null;
  proposed: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  version: number;
}
const COLUMNS = `id, patient_id, target_kind, target_id, proposed, reason, status, requested_by,
  requested_at, decided_by, decided_at, decision_reason, version`;

const view = (row: Row) => ({
  id: row.id,
  patientId: row.patient_id,
  targetKind: row.target_kind,
  ...(row.target_id ? { targetId: row.target_id } : {}),
  proposed: row.proposed,
  reason: row.reason,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at.toISOString(),
  ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
  ...(row.decided_at ? { decidedAt: row.decided_at.toISOString() } : {}),
  ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
  version: row.version,
});

const notFound = () => new HttpError(404, 'not_found', 'No such correction request');
const encodeCursor = (row: Row) =>
  Buffer.from(`${row.requested_at.toISOString()}|${row.id}`).toString('base64url');
function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || Number.isNaN(Date.parse(at)) || !id || !UUID.test(id)) {
    throw new HttpError(400, 'invalid_cursor', 'The cursor does not belong to this list');
  }
  return { at, id };
}

export const correctionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of CORRECTION_SCHEMAS) app.addSchema(schema);

  const userIdOf = (request: FastifyRequest): string => {
    const userId = request.session?.userId;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
    return userId;
  };

  async function reachable(request: FastifyRequest, patientId: string, permission: Permission) {
    const inScope = await patientInScope(request.txClient, patientId, {
      scope: request.access.scope(permission),
      userId: userIdOf(request),
    });
    if (!inScope) throw new HttpError(404, 'not_found', 'No such patient');
  }

  async function listPage(request: FastifyRequest, query: ListQuery, patientId?: string) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (patientId) {
      params.push(patientId);
      where.push(`patient_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    if (query.cursor) {
      const at = decodeCursor(query.cursor);
      params.push(at.at, at.id);
      where.push(
        `(requested_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(query.limit + 1);
    const { rows } = await request.txClient.query<Row>(
      `select ${COLUMNS} from record_correction_requests
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by requested_at desc, id desc limit $${params.length}`,
      params,
    );
    const page = rows.slice(0, query.limit);
    for (const row of page) request.audit('read', 'record_correction_request', row.id);
    const last = page[page.length - 1];
    return {
      items: page.map(view),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  app.post(
    '/patients/:patientId/correction-requests',
    {
      config: {
        permissions: [REQUEST],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'requestRecordCorrection',
        tags: ['records'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Asks for a correction to a patient’s record (#556): what should change (`proposed`) and why (`reason`), for the patient record itself or one of their encounters or documents (422 `target_mismatch` when it is not theirs). Nothing is edited: a second person decides. Announced as `correction.requested`. 409 `patient_merged` for a merged record. Requires correction:request.',
        params: PatientParams,
        body: ref(CorrectionRequestCreate),
        response: { 201: ref(CorrectionRequest), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as CorrectionRequestCreate;
      const userId = userIdOf(request);
      const { patientId } = request.params;
      await reachable(request, patientId, REQUEST);
      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await request.txClient.query<Row>(
              `select ${COLUMNS} from record_correction_requests where id = $1`,
              [request.idempotentId],
            )
          : null;
        const row = again?.rows[0];
        if (!row) throw notFound();
        return reply.status(201).send(view(row));
      }
      const proposed = tidyWithin(body.proposed, 1000);
      const reason = tidyWithin(body.reason, 300);
      if (!proposed || !reason) {
        throw new HttpError(400, 'validation_failed', 'Say what to change and why');
      }
      if ((body.targetKind === 'patient') !== (body.targetId === undefined)) {
        throw new HttpError(422, 'target_mismatch', 'Name the encounter or document to correct');
      }
      if (body.targetKind !== 'patient') {
        const table = body.targetKind === 'encounter' ? 'encounters' : 'patient_documents';
        const { rowCount } = await request.txClient.query(
          `select 1 from ${table} where id = $1 and patient_id = $2`,
          [body.targetId, patientId],
        );
        if (rowCount !== 1) {
          throw new HttpError(422, 'target_mismatch', 'That record is not this patient’s');
        }
      }
      const { rows } = await request.txClient.query<Row>(
        `insert into record_correction_requests
           (tenant_id, patient_id, target_kind, target_id, proposed, reason, requested_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
        [patientId, body.targetKind, body.targetId ?? null, proposed, reason, userId],
      );
      const row = rows[0]!;
      request.idempotentId = row.id;
      request.audit('create', 'record_correction_request', row.id);
      await request.emit('correction.requested', row.id, {
        patientId,
        targetKind: row.target_kind,
      });
      return reply.status(201).send(view(row));
    },
  );

  app.get(
    '/patients/:patientId/correction-requests',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listPatientCorrectionRequests',
        tags: ['records'],
        description:
          'The requests to correct a patient’s record (#556), newest first, one cursor page at a time; `status` narrows. Requires correction:read, within the scope the role holds it with.',
        params: PatientParams,
        querystring: ListQuery,
        response: { 200: ref(CorrectionRequestPage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      await reachable(request, request.params.patientId, READ);
      return listPage(request, request.query as ListQuery, request.params.patientId);
    },
  );

  app.get(
    '/correction-requests',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listCorrectionRequests',
        tags: ['records'],
        description:
          'Every request to correct a record in the hospital (#556), newest first, with `status` to narrow to the pending ones. Requires correction:read with the scope `all` (403 otherwise).',
        querystring: ListQuery,
        response: { 200: ref(CorrectionRequestPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      if (request.access.scope(READ) !== 'all') {
        throw new HttpError(403, 'forbidden', 'Not allowed');
      }
      return listPage(request, request.query as ListQuery);
    },
  );

  async function decide(request: FastifyRequest, outcome: 'approved' | 'rejected') {
    const { requestId } = request.params as { requestId: string };
    const body = request.body as CorrectionRequestDecide;
    const userId = userIdOf(request);
    const found = await request.txClient.query<Row>(
      `select ${COLUMNS} from record_correction_requests where id = $1 for update`,
      [requestId],
    );
    const current = found.rows[0];
    if (!current) throw notFound();
    try {
      await reachable(request, current.patient_id, DECIDE);
    } catch {
      throw notFound();
    }
    if (current.status !== 'pending') {
      throw new HttpError(409, 'already_decided', 'This request was decided already');
    }
    if (current.version !== body.expectedVersion) {
      throw new HttpError(409, 'conflict', 'The request has changed since it was read');
    }
    if (current.requested_by === userId) {
      throw new HttpError(403, 'second_person_required', 'Someone else must decide your request');
    }
    const reason = tidyWithin(body.reason, 300);
    if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is needed');
    const { rows } = await request.txClient.query<Row>(
      `update record_correction_requests
          set status = $2, decided_by = $3, decided_at = now(), decision_reason = $4
        where id = $1 returning ${COLUMNS}`,
      [current.id, outcome, userId, reason],
    );
    const row = rows[0]!;
    request.audit('update', 'record_correction_request', row.id);
    await request.emit(
      outcome === 'approved' ? 'correction.approved' : 'correction.rejected',
      row.id,
      {
        patientId: row.patient_id,
        targetKind: row.target_kind,
        ...(row.target_id ? { targetId: row.target_id } : {}),
      },
    );
    return view(row);
  }

  for (const [path, outcome, operationId] of [
    ['approve', 'approved', 'approveCorrectionRequest'],
    ['reject', 'rejected', 'rejectCorrectionRequest'],
  ] as const) {
    app.post(
      `/correction-requests/:requestId/${path}`,
      {
        config: { permissions: [DECIDE, READ], feature: FEATURE },
        schema: {
          operationId,
          tags: ['records'],
          description: `${outcome === 'approved' ? 'Approves' : 'Rejects'} a pending request to correct a record, with a reason (#556). Decided once, by someone other than the person who asked (403 \`second_person_required\`); 409 \`already_decided\`; 409 \`conflict\` when the version is not the one read. Approving edits nothing: the module that owns the record applies the change, reacting to \`correction.approved\`. Requires correction:decide and correction:read.`,
          params: RequestParams,
          body: ref(CorrectionRequestDecide),
          response: { 200: ref(CorrectionRequest), ...errors(400, 401, 403, 404, 409, 429) },
        },
      },
      (request) => decide(request, outcome),
    );
  }
};
