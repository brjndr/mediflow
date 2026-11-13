import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { insertAuditEntries } from '../../core/audit/plugin.js';
import { signDownload, verifyDownload } from '../../core/files/signing.js';
import { HttpError } from '../../core/http/errors.js';
import {
  CursorQuery,
  DEFAULT_PAGE_SIZE,
  StringEnum,
  errors,
  ref,
} from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { WORKER_ROLE } from '../../core/outbox/dispatcher.js';
import { computeReport, isSnapshot, readAtHospital, SYNC_MAX_ROWS, TooLarge } from './compute.js';
import { ReportGate } from './gate.js';
import { RUN_JOB, type RunJob } from './jobs.js';
import {
  findRun,
  insertRun,
  limitsOf,
  listRuns,
  lockQuota,
  resultOf,
  UUID,
  type RunRow,
} from './repository.js';
import {
  MAX_RANGE_DAYS,
  MAX_SYNC_RANGE_DAYS,
  REPORT_KINDS,
  REPORT_SCHEMAS,
  ReportDownload,
  ReportLimits,
  ReportRequest,
  ReportResult,
  ReportRun,
  ReportRunPage,
  type ReportKind,
} from './schemas.js';

const FEATURE = 'reports';
const READ = 'report:read';
const EXPORT = 'report:export';

/** Reports are the whole hospital's, so only the scope `all` reaches them. */
function requireAll(request: FastifyRequest, ...permissions: (typeof READ | typeof EXPORT)[]) {
  for (const permission of permissions) {
    if (request.access.scope(permission) !== 'all') {
      throw new HttpError(403, 'permission_denied', 'Reports need the scope all');
    }
  }
}

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayNumber = (value: string): number | null => {
  const match = DAY.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  // A day that is not on the calendar (the 31st of June) does not round into the next month.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return ms / 86_400_000;
};

/** The days a report covers, checked. A snapshot (stock) takes none and ignores any sent. */
function rangeOf(
  kind: ReportKind,
  body: Static<typeof ReportRequest>,
  maxDays: number,
): { from: string | null; to: string | null } {
  if (isSnapshot(kind)) return { from: null, to: null };
  if (body.from === undefined || body.to === undefined) {
    throw new HttpError(422, 'range_required', 'This report needs from and to');
  }
  const first = dayNumber(body.from);
  const last = dayNumber(body.to);
  if (first === null || last === null || first > last) {
    throw new HttpError(422, 'range_invalid', 'from and to must be days, from not after to');
  }
  if (last - first + 1 > maxDays) {
    throw new HttpError(422, 'range_too_long', `A report covers at most ${maxDays} days`);
  }
  return { from: body.from, to: body.to };
}

const view = (row: RunRow, result?: Static<typeof ReportResult> | null): ReportRun => ({
  id: row.id,
  kind: row.kind,
  from: row.range_from,
  to: row.range_to,
  status: row.status,
  requestedBy: { id: row.requested_by, name: row.requested_by_name },
  requestedAt: row.requested_at.toISOString(),
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
  expiresAt: row.expires_at.toISOString(),
  ...(row.row_count === null ? {} : { rowCount: row.row_count }),
  ...(row.failure === null ? {} : { failure: row.failure }),
  ...(result ? { result } : {}),
});

const runNotFound = () => new HttpError(404, 'report_run_not_found', 'No such report');
const OTHER_HOSPITAL =
  ' A report of another hospital answers 404 report_run_not_found, the same as one that does not exist.';

const KindParams = Type.Object({ kind: StringEnum(REPORT_KINDS) });
const RunParams = Type.Object({ runId: Type.String({ maxLength: 64 }) });
const DownloadQuery = Type.Object({
  expires: Type.Integer({ minimum: 0 }),
  signature: Type.String({ maxLength: 100 }),
});

export const reportRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of REPORT_SCHEMAS) app.addSchema(schema);
  const gate = new ReportGate();

  app.get(
    '/reports/limits',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getReportLimits',
        tags: ['reports'],
        description:
          'What the hospital may ask of the reporting service (stored reports at the same time and in a day, how long they are kept) and what it has used. Requires report:read with the scope `all`.',
        response: { 200: ref(ReportLimits), ...errors(401, 403, 409, 429) },
      },
    },
    async (request) => {
      requireAll(request, READ);
      return limitsOf(request.txClient);
    },
  );

  app.post(
    '/reports/:kind',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'runReport',
        tags: ['reports'],
        description:
          'Works out an operational report now and answers it: `opd_census` (OPD visits by day and department), `opd_hourly` (OPD visits opened by day and hour of the day at the hospital), `revenue` (invoiced, credited, collected and refunded by day), `doctor_activity` (OPD encounters and appointments by doctor), `pharmacy_sales` (counter sales, returns and dispenses by day), `lab_turnaround` (minutes from collecting a sample to its verified result, by test) `collections` (payments and refunds by day, payment method and the person who took them), `outstanding` (issued invoices not fully paid by age, a snapshot of now) or `stock` (what is on hand, a snapshot of now). It reads from the replica under a time limit, covers at most 31 days and 5,000 rows (422 `range_too_long`, `report_too_large`, `report_timeout`: ask for a stored report instead), and a hospital may run one at a time (429 `report_busy` with Retry-After). The body is a POST so filters stay out of logs. Requires report:read with the scope `all` and the reports feature flag. Audited as a read of `report`.',
        params: KindParams,
        body: ref(ReportRequest),
        response: { 200: ref(ReportResult), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, READ);
      const { kind } = request.params as Static<typeof KindParams>;
      const range = rangeOf(
        kind,
        request.body as Static<typeof ReportRequest>,
        MAX_SYNC_RANGE_DAYS,
      );
      const tenantId = request.tenant?.id;
      if (!tenantId) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');

      const release = gate.enter(tenantId);
      if (!release) {
        throw new HttpError(429, 'report_busy', 'A report is already being worked out', {
          'retry-after': '5',
        });
      }
      try {
        // The read is audited and the request's transaction ended before the report is worked
        // out, so the primary's connection goes back to the pool and is not held, idle, for as
        // long as the report takes (with no replica the report needs a second one).
        await insertAuditEntries(request.txClient, userIdOf(request), request.id, [
          { action: 'read', entity: 'report', entityId: null },
        ]);
        await request.commitNow();
        return await readAtHospital(
          app.database.reportPool,
          tenantId,
          app.config.REPORT_SYNC_TIMEOUT_MS,
          (client) => computeReport(client, kind, range, SYNC_MAX_ROWS),
        );
      } catch (error) {
        if (error instanceof TooLarge) {
          throw new HttpError(422, 'report_too_large', 'Too many rows: ask for a stored report');
        }
        if ((error as { code?: unknown }).code === '57014') {
          throw new HttpError(
            422,
            'report_timeout',
            'Too slow: narrow the days or ask for a stored report',
          );
        }
        throw error;
      } finally {
        release();
      }
    },
  );

  app.post(
    '/reports/:kind/runs',
    {
      config: {
        permissions: [EXPORT, READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createReportRun',
        tags: ['reports'],
        headers: RequiredIdempotencyHeaders,
        description:
          "Asks for a stored report: it is made by a job (up to 366 days and 20,000 rows) and kept, with a CSV file, for the hospital's retention. Answers 202 with the run, `queued`; read it by id until it has succeeded or failed. The hospital's quota applies: at most `maxConcurrent` waiting or running and `maxPerDay` in 24 hours (429 `report_quota` with Retry-After), so one hospital's heavy reports never crowd out another's. The Idempotency-Key header is required: a repeat adds nothing and answers with the run as it is now. Requires report:export and report:read with the scope `all`. Audited as a create of `report_run`.",
        params: KindParams,
        body: ref(ReportRequest),
        response: { 202: ref(ReportRun), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      requireAll(request, EXPORT, READ);
      if (request.replayOf !== null) {
        const made = request.idempotentId
          ? await findRun(request.txClient, request.idempotentId)
          : null;
        if (!made) throw runNotFound();
        request.audit('read', 'report_run', made.id);
        return reply.status(202).send(view(made));
      }
      const { kind } = request.params as Static<typeof KindParams>;
      const range = rangeOf(kind, request.body as Static<typeof ReportRequest>, MAX_RANGE_DAYS);
      const tenantId = request.tenant?.id;
      if (!tenantId) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');

      // One request at a time counts the hospital's runs, so none sees room another has taken.
      await lockQuota(request.txClient);
      const limits = await limitsOf(request.txClient);
      if (limits.active >= limits.maxConcurrent || limits.usedToday >= limits.maxPerDay) {
        throw new HttpError(429, 'report_quota', 'The hospital has used its reports for now', {
          'retry-after': limits.active >= limits.maxConcurrent ? '60' : '3600',
        });
      }
      const id = await insertRun(
        request.txClient,
        { kind, ...range, userId: userIdOf(request) },
        limits.retentionDays,
      );
      request.idempotentId = id;
      request.audit('create', 'report_run', id);
      const job: RunJob = { tenantId, runId: id };
      // After the commit, so the job never looks for a row that is not there yet. If the process
      // stops between the two, the run is given up as `stalled` by the hourly sweep.
      request.afterCommit(() => app.jobs.send(RUN_JOB, job, { id, retryLimit: 2, retryDelay: 30 }));
      const made = await findRun(request.txClient, id);
      if (!made) throw runNotFound();
      return reply.status(202).send(view(made));
    },
  );

  app.get(
    '/reports/runs',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listReportRuns',
        tags: ['reports'],
        description:
          "The hospital's stored reports, newest first, without their results. Requires report:read with the scope `all`.",
        querystring: CursorQuery,
        response: { 200: ref(ReportRunPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      requireAll(request, READ);
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listRuns(request.txClient, cursor, limit);
      if (!page) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
      return { items: page.rows.map((row) => view(row)), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/reports/runs/:runId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getReportRun',
        tags: ['reports'],
        description:
          'One stored report, with its result once it has succeeded. Requires report:read with the scope `all`.' +
          OTHER_HOSPITAL,
        params: RunParams,
        response: { 200: ref(ReportRun), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      requireAll(request, READ);
      const row = await findRun(request.txClient, request.params.runId);
      if (!row) throw runNotFound();
      const result = row.status === 'succeeded' ? await resultOf(request.txClient, row.id) : null;
      request.audit('read', 'report_run', row.id);
      return view(row, result);
    },
  );

  app.get(
    '/reports/runs/:runId/download-url',
    {
      config: { permissions: [EXPORT, READ], feature: FEATURE },
      schema: {
        operationId: 'getReportDownloadUrl',
        tags: ['reports'],
        description:
          'A signed, short-lived address for the CSV file of a succeeded report (`REPORT_URL_TTL_SECONDS`, five minutes). The link needs no session, so give it only to the person who asked; it is audited here, as an `export` of the run. 409 `report_not_ready` until the run has succeeded. Requires report:export and report:read with the scope `all`.' +
          OTHER_HOSPITAL,
        params: RunParams,
        response: { 200: ref(ReportDownload), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      requireAll(request, EXPORT, READ);
      const row = await findRun(request.txClient, request.params.runId);
      if (!row) throw runNotFound();
      if (row.expires_at.getTime() <= Date.now()) throw runNotFound();
      if (row.status !== 'succeeded' || row.file_key === null) {
        throw new HttpError(409, 'report_not_ready', 'The report has no file yet');
      }
      const expires = Math.floor(Date.now() / 1000) + app.config.REPORT_URL_TTL_SECONDS;
      const presigned = await app.files.presign?.(row.file_key, app.config.REPORT_URL_TTL_SECONDS);
      const signature = signDownload(app.config.REPORT_URL_SECRET, row.id, expires);
      request.audit('export', 'report_run', row.id);
      return {
        url: presigned ?? `/report-files/${row.id}?expires=${expires}&signature=${signature}`,
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },
  );

  // The signed link is the credential, so this route has no session and no hospital. It finds
  // the run as the worker role and answers one thing for every refusal: a link that is forged,
  // expired, for a run that is gone or whose file is gone is the same 404.
  app.get(
    '/report-files/:runId',
    {
      // Per client address: a flood of links, signed or not, never reaches the database.
      config: { access: 'public', rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        operationId: 'downloadReportFile',
        tags: ['reports'],
        description:
          'The CSV file of a stored report, for a link made by `getReportDownloadUrl`. The signature in the query is the only credential. 404 `report_file_not_found` for anything else.',
        params: RunParams,
        querystring: DownloadQuery,
        response: { 200: Type.String({ description: 'The CSV file.' }), ...errors(400, 404, 429) },
      },
    },
    async (request, reply) => {
      const { runId } = request.params;
      const { expires, signature } = request.query;
      const gone = () => new HttpError(404, 'report_file_not_found', 'No such file');
      if (!UUID.test(runId)) throw gone();
      if (!verifyDownload(app.config.REPORT_URL_SECRET, runId, expires, signature)) throw gone();

      const client = await app.database.pool.connect();
      let row: {
        file_key: string;
        kind: string;
        range_from: string | null;
        range_to: string | null;
      };
      try {
        await client.query('begin');
        await client.query(`set local role ${WORKER_ROLE}`);
        const { rows } = await client.query<typeof row>(
          `select file_key, kind, range_from::text as range_from, range_to::text as range_to
           from report_runs
           where id = $1 and status = 'succeeded' and file_key is not null and expires_at > now()`,
          [runId],
        );
        await client.query('commit');
        if (!rows[0]) throw gone();
        row = rows[0];
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const file = await app.files.get(row.file_key);
      if (!file) throw gone();
      const name = ['report', row.kind, row.range_from, row.range_to].filter(Boolean).join('-');
      // The link has no session, so nothing in the audit log says who took the file: this line
      // (ids only) says that it was taken, and when.
      request.log.info({ event: 'report_file_downloaded', runId }, 'report file downloaded');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}.csv"`)
        .header('x-content-type-options', 'nosniff')
        .send(file);
    },
  );
};
