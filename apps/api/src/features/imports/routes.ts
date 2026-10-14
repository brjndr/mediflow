import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import type { ImportKind } from '../../core/imports/registry.js';
import { CHECK_JOB, COMMIT_JOB, type BatchJob } from './jobs.js';
import {
  addRows,
  deleteRows,
  findBatch,
  insertBatch,
  isAlreadyWriting,
  listBatches,
  listProblems,
  lockBatch,
  setStatus,
  type BatchRow,
} from './repository.js';
import {
  BATCH_ROWS_MAX,
  IMPORT_SCHEMAS,
  ImportBatch,
  ImportBatchCreate,
  ImportBatchPage,
  ImportKindList,
  ImportListQuery,
  ImportProblemPage,
  ImportRowsUpload,
} from './schemas.js';

const FEATURE = 'imports';
const READ = 'import:read';
const RUN = 'import:run';

const view = (row: BatchRow): ImportBatch => ({
  id: row.id,
  tenantId: row.tenant_id,
  kind: row.kind,
  status: row.status,
  rowCount: row.row_count,
  doneCount: row.done_count,
  problemCount: row.problem_count,
  ...(row.failure === null ? {} : { failure: row.failure }),
  createdBy: { id: row.created_by, name: row.created_by_name },
  createdAt: row.created_at.toISOString(),
  ...(row.checked_at === null ? {} : { checkedAt: row.checked_at.toISOString() }),
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
});

// One answer for a batch that does not exist and one of another hospital.
const notFound = () => new HttpError(404, 'import_not_found', 'No such batch');
const wrongState = (code: string, message: string) => new HttpError(409, code, message);

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

/**
 * Whether the caller may load this kind: the hospital has its module on and the caller holds
 * what adding one such record on its own screen takes, besides `import:run`.
 */
async function mayLoad(request: FastifyRequest, kind: ImportKind): Promise<boolean> {
  const policy = await request.access.policy();
  if (!policy || policy.features[kind.feature] !== true) return false;
  const held = new Set(policy.permissions.map((grant) => grant.permission));
  return kind.permissions.every((permission) => held.has(permission));
}

const OTHER_HOSPITAL =
  ' A batch of another hospital answers 404 import_not_found, the same as one that does not exist.';

export const importRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of IMPORT_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ batchId: Type.String({ maxLength: 64 }) });

  /** The kind of a batch, refused (403) when the caller may not load it. */
  async function kindFor(request: FastifyRequest, name: string): Promise<ImportKind> {
    const kind = app.importKinds.get(name);
    if (!kind) throw new HttpError(400, 'validation_failed', 'No such kind of record');
    if (!(await mayLoad(request, kind))) {
      throw new HttpError(403, 'permission_denied', 'Loading this kind needs its own permission');
    }
    return kind;
  }

  /** The batch, locked, of a kind the caller may load. */
  async function batchFor(request: FastifyRequest, batchId: string) {
    const batch = await lockBatch(request.txClient, batchId);
    if (!batch) throw notFound();
    const kind = await kindFor(request, batch.kind);
    return { batch, kind };
  }

  const send = (request: FastifyRequest, name: string, batchId: string) => {
    const job: BatchJob = { tenantId: request.tenant?.id ?? '', batchId };
    // After the commit, so the job finds the batch in the state this request left it in.
    request.afterCommit(() => app.jobs.send(name, job));
  };

  app.get(
    '/imports/kinds',
    {
      config: { permissions: [RUN], feature: FEATURE },
      schema: {
        operationId: 'listImportKinds',
        tags: ['imports'],
        description:
          'The kinds of record the caller may load from a file, each with its fields: those whose module the hospital has on and whose own permission the caller holds (adding one on its screen).',
        response: { 200: ref(ImportKindList), ...errors(401, 403, 409, 429) },
      },
    },
    async (request) => {
      const items = [];
      for (const kind of app.importKinds.all()) {
        if (!(await mayLoad(request, kind))) continue;
        items.push({
          kind: kind.kind,
          columns: kind.columns.map((column) => ({
            field: column.field,
            required: column.required,
            type: column.type,
            ...(column.type === 'enum' ? { values: [...column.values] } : {}),
          })),
        });
      }
      return { items };
    },
  );

  app.get(
    '/imports',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listImports',
        tags: ['imports'],
        description: "The hospital's batches, newest first.",
        querystring: ImportListQuery,
        response: { 200: ref(ImportBatchPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const result = await listBatches(
        request.txClient,
        request.query.cursor,
        request.query.limit ?? DEFAULT_PAGE_SIZE,
      );
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return { items: result.rows.map(view), nextCursor: result.nextCursor };
    },
  );

  app.post(
    '/imports',
    {
      // The answer holds counts and codes only, so a replay can return it whole.
      config: { permissions: [RUN], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createImport',
        tags: ['imports'],
        headers: IdempotencyHeaders,
        description:
          'Starts a batch of one kind, to which the rows of a file are then sent. Loading a kind needs what adding one such record on its screen needs, and its module on (403 permission_denied otherwise). Audited.',
        body: ref(ImportBatchCreate),
        response: { 201: ref(ImportBatch), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const kind = await kindFor(request, (request.body as ImportBatchCreate).kind);
      const id = await insertBatch(request.txClient, kind.kind, userIdOf(request));
      request.audit('create', 'import_batch', id);
      const row = await findBatch(request.txClient, id);
      if (!row) throw notFound();
      return reply.status(201).send(view(row));
    },
  );

  app.get(
    '/imports/:batchId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getImport',
        tags: ['imports'],
        description: 'One batch, with how far its job has got.' + OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(ImportBatch), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findBatch(request.txClient, request.params.batchId);
      if (!row) throw notFound();
      return view(row);
    },
  );

  app.post(
    '/imports/:batchId/rows',
    {
      config: { permissions: [RUN], feature: FEATURE },
      schema: {
        operationId: 'addImportRows',
        tags: ['imports'],
        description: `Adds rows to a batch that is being staged, up to ${BATCH_ROWS_MAX} in all (409 import_too_many_rows). A line already sent is kept as it was first sent, so a chunk sent again adds nothing. The rows can be patient data: the API does not log the body, and they are deleted once the batch is written, refused or given up. Audited.${OTHER_HOSPITAL}`,
        params: Params,
        body: ref(ImportRowsUpload),
        response: { 200: ref(ImportBatch), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { batch, kind } = await batchFor(request, request.params.batchId);
      if (batch.status !== 'staging') {
        throw wrongState('import_not_staging', 'Rows are added only before the check');
      }
      const { fields, rows } = request.body as ImportRowsUpload;
      const known = new Set(kind.columns.map((column) => column.field));
      if (new Set(fields).size !== fields.length || fields.some((field) => !known.has(field))) {
        throw new HttpError(400, 'validation_failed', 'A field is unknown or named twice');
      }
      if (rows.some((row) => row.values.length !== fields.length)) {
        throw new HttpError(400, 'validation_failed', 'A row has a value for each field');
      }
      const count = await addRows(
        request.txClient,
        batch.id,
        rows.map((row) => ({
          line: row.line,
          values: Object.fromEntries(
            fields.map((field, index) => [field, row.values[index] ?? '']),
          ),
        })),
      );
      if (count > BATCH_ROWS_MAX) {
        throw wrongState('import_too_many_rows', `A batch holds at most ${BATCH_ROWS_MAX} rows`);
      }
      request.audit('stage', 'import_batch', batch.id);
      const row = await findBatch(request.txClient, batch.id);
      if (!row) throw notFound();
      return view(row);
    },
  );

  app.post(
    '/imports/:batchId/check',
    {
      config: { permissions: [RUN], feature: FEATURE },
      schema: {
        operationId: 'checkImport',
        tags: ['imports'],
        description:
          'Starts the dry run of a staged batch: a job checks every row as its create route would, and writes nothing. Follow its progress on the batch; its problems are then in the report. 409 import_empty for a batch with no rows.' +
          OTHER_HOSPITAL,
        params: Params,
        response: { 202: ref(ImportBatch), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const { batch } = await batchFor(request, request.params.batchId);
      if (batch.status !== 'staging') {
        throw wrongState('import_not_staging', 'Only a staged batch is checked');
      }
      if (batch.row_count === 0) throw wrongState('import_empty', 'The batch has no rows');
      await setStatus(request.txClient, batch.id, 'checking');
      send(request, CHECK_JOB, batch.id);
      const row = await findBatch(request.txClient, batch.id);
      if (!row) throw notFound();
      return reply.status(202).send(view(row));
    },
  );

  app.post(
    '/imports/:batchId/commit',
    {
      config: { permissions: [RUN], feature: FEATURE },
      schema: {
        operationId: 'commitImport',
        tags: ['imports'],
        description:
          'Writes a checked batch with no problems (409 import_not_ready otherwise): a job writes every row in one transaction, each audited and announced as its create route does, so the batch is all of its rows or none. A row refused at that moment (the catalog changed since the check) fails the whole batch, with its report. One batch is written at a time at a hospital (409 import_running). Audited.' +
          OTHER_HOSPITAL,
        params: Params,
        response: { 202: ref(ImportBatch), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const { batch } = await batchFor(request, request.params.batchId);
      if (batch.status !== 'checked' || batch.problem_count > 0) {
        throw wrongState('import_not_ready', 'Only a checked batch with no problems is written');
      }
      try {
        await setStatus(request.txClient, batch.id, 'queued', { committedBy: userIdOf(request) });
      } catch (error) {
        // The request rolls back: the batch stays checked and can be written later.
        if (isAlreadyWriting(error)) {
          throw wrongState('import_running', 'Another batch is being written at this hospital');
        }
        throw error;
      }
      request.audit('commit', 'import_batch', batch.id);
      send(request, COMMIT_JOB, batch.id);
      const row = await findBatch(request.txClient, batch.id);
      if (!row) throw notFound();
      return reply.status(202).send(view(row));
    },
  );

  app.post(
    '/imports/:batchId/cancel',
    {
      config: { permissions: [RUN], feature: FEATURE },
      schema: {
        operationId: 'cancelImport',
        tags: ['imports'],
        description:
          'Gives up a batch that is staged or checked: its rows are deleted and nothing is written. A batch whose job is running is not given up (409 import_busy). Cancelling twice changes nothing. Audited.' +
          OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(ImportBatch), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { batch } = await batchFor(request, request.params.batchId);
      if (batch.status === 'staging' || batch.status === 'checked') {
        await setStatus(request.txClient, batch.id, 'cancelled');
        await deleteRows(request.txClient, batch.id);
        request.audit('cancel', 'import_batch', batch.id);
      } else if (batch.status !== 'cancelled') {
        throw wrongState('import_busy', 'This batch is being checked or written, or is done');
      }
      const row = await findBatch(request.txClient, batch.id);
      if (!row) throw notFound();
      return view(row);
    },
  );

  app.get(
    '/imports/:batchId/problems',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listImportProblems',
        tags: ['imports'],
        description:
          'The report of a batch: what is wrong with which line and field, in the order of the lines. Codes only, never a value of the file.' +
          OTHER_HOSPITAL,
        params: Params,
        querystring: ImportListQuery,
        response: { 200: ref(ImportProblemPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const batch = await findBatch(request.txClient, request.params.batchId);
      if (!batch) throw notFound();
      const { cursor } = request.query;
      const after = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(after) || after < 0) {
        throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      }
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      const rows = await listProblems(request.txClient, batch.id, after, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          line: row.line,
          ...(row.field === null ? {} : { field: row.field }),
          code: row.code,
        })),
        nextCursor: rows.length > limit && last ? String(last.seq) : null,
        ...(cursor === undefined ? { total: batch.problem_count } : {}),
      };
    },
  );
};
