import type pg from 'pg';
import { loadPolicy } from '../../core/access/policy.js';
import { insertAuditEntries, type AuditEntry } from '../../core/audit/plugin.js';
import { HttpError } from '../../core/http/errors.js';
import {
  RowProblem,
  type ImportKind,
  type ImportKinds,
  type Writer,
} from '../../core/imports/registry.js';
import type { DomainEvent } from '../../core/outbox/events.js';
import { insertEvent } from '../../core/outbox/plugin.js';
import { APP_ROLE } from '../../core/tenancy/plugin.js';
import { convert, minorDigitsOf, type Problem } from './convert.js';
import { currencyOfHospital, deleteRows, readRows, replaceProblems } from './repository.js';

export const CHECK_JOB = 'imports.check';
export const COMMIT_JOB = 'imports.commit';

export interface BatchJob {
  tenantId: string;
  batchId: string;
}

type LineProblem = Problem & { line: number };

/** Rows read, and progress told, at a time. */
const PAGE = 500;
/** A job that has not said it is alive for this long is taken over by the next delivery. */
export const STALE_MINUTES = 10;

/** Thrown inside `atHospital` to end the transaction with a rollback and answer `value`. */
class Rollback<T> {
  constructor(readonly value: T) {}
}

/**
 * Runs `work` in one transaction as the app role at the hospital, as a request does: it commits
 * when `work` returns, rolls back when it throws (or throws a `Rollback`), and gives the connection
 * back exactly once.
 */
async function atHospital<T>(
  pool: pg.Pool,
  tenantId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch((failure: unknown) => {
      // The connection is in an unknown state: it is destroyed, not given back to the pool.
      broken = failure instanceof Error ? failure : new Error('rollback failed');
    });
    if (error instanceof Rollback) return error.value as T;
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * What a job writes through, as a request would: its transaction, an audit entry for each record
 * by the person who asked for the batch, and the events of each record in the outbox, all of
 * which exist only if the transaction commits.
 */
class JobWriter implements Writer {
  private readonly entries: AuditEntry[] = [];

  constructor(
    readonly txClient: pg.PoolClient,
    private readonly actorId: string,
    private readonly batchId: string,
  ) {}

  audit(action: string, entity: string, entityId?: string): void {
    // An entry about no one record (a duplicate check) is written once for the whole batch.
    if (
      entityId === undefined &&
      this.entries.some((entry) => entry.action === action && entry.entity === entity)
    ) {
      return;
    }
    this.entries.push({ action, entity, entityId: entityId ?? null });
  }

  emit(event: DomainEvent, entityId: string, payload?: Record<string, unknown>): Promise<void> {
    return insertEvent(this.txClient, event, entityId, this.actorId, payload);
  }

  /** Writes the audit entries, each tied to the batch where a request's would name the request. */
  async flush(): Promise<void> {
    await insertAuditEntries(this.txClient, this.actorId, `import:${this.batchId}`, this.entries);
    this.entries.length = 0;
  }
}

/** The problem a refusal of `prepare` or `write` is, or the error again when it is not one. */
function problemOf(error: unknown): Problem {
  if (error instanceof RowProblem) return { field: error.field, code: error.code };
  if (error instanceof HttpError && error.statusCode < 500) return { code: error.code };
  throw error;
}

interface Claim {
  kind: string;
  actorId: string;
  token: string;
}

/**
 * Takes the batch for this delivery of the job: it is in the state the job is for, and no other
 * delivery has it (or the one that had it has stopped saying it is alive). Every later change the
 * job makes names the token, so a delivery that was taken over changes nothing. A second delivery
 * of a job that has finished finds nothing to take.
 */
function claim(pool: pg.Pool, job: BatchJob, from: 'checking' | 'queued'): Promise<Claim | null> {
  return atHospital(pool, job.tenantId, async (client) => {
    const { rows } = await client.query<{
      kind: string;
      created_by: string;
      committed_by: string | null;
      token: string;
    }>(
      from === 'checking'
        ? `update import_batches
           set heartbeat_at = now(), done_count = 0, claim_token = gen_random_uuid()
           where id = $1 and status = 'checking'
             and (claim_token is null or heartbeat_at < now() - make_interval(mins => $2))
           returning kind, created_by, committed_by, claim_token as token`
        : `update import_batches
           set status = 'running', heartbeat_at = now(), done_count = 0,
               claim_token = gen_random_uuid()
           where id = $1
             and (status = 'queued'
                  or (status = 'running' and heartbeat_at < now() - make_interval(mins => $2)))
           returning kind, created_by, committed_by, claim_token as token`,
      [job.batchId, STALE_MINUTES],
    );
    const row = rows[0];
    if (!row) return null;
    return { kind: row.kind, actorId: row.committed_by ?? row.created_by, token: row.token };
  });
}

/** Tells how far the job has got, in a transaction of its own, so the screen sees it at once. */
const progress = (pool: pg.Pool, job: BatchJob, token: string, done: number) =>
  atHospital(pool, job.tenantId, (client) =>
    client.query(
      'update import_batches set done_count = $3, heartbeat_at = now() where id = $1 and claim_token = $2',
      [job.batchId, token, done],
    ),
  );

/**
 * Ends the job's hold on the batch with its outcome, if the job still has it. False when another
 * delivery took the batch over: then nothing is changed.
 */
async function settle(
  client: pg.PoolClient,
  job: BatchJob,
  token: string,
  outcome: { status: 'checked' | 'committed' | 'failed'; problems?: number; failure?: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update import_batches
     set status = $3, problem_count = coalesce($4, problem_count), failure = $5,
         heartbeat_at = null, claim_token = null,
         checked_at = case when $3 = 'checked' then now() else checked_at end,
         finished_at = case when $3 in ('committed', 'failed') then now() else finished_at end
     where id = $1 and claim_token = $2`,
    [job.batchId, token, outcome.status, outcome.problems ?? null, outcome.failure ?? null],
  );
  return rowCount === 1;
}

/** Ends a batch that was not written: its state, its report if it has one, and its rows gone. */
function refuse(
  pool: pg.Pool,
  job: BatchJob,
  token: string,
  failure: string,
  problems: LineProblem[] = [],
): Promise<void> {
  return atHospital(pool, job.tenantId, async (client) => {
    if (
      !(await settle(client, job, token, { status: 'failed', failure, problems: problems.length }))
    ) {
      return;
    }
    await replaceProblems(client, job.batchId, problems);
    await deleteRows(client, job.batchId);
  });
}

/** Whether the person still holds what loading this kind takes, at the hospital, now. */
async function stillAllowed(
  client: pg.PoolClient,
  tenantId: string,
  actorId: string,
  kind: ImportKind,
): Promise<boolean> {
  const policy = await loadPolicy(client, tenantId, actorId);
  if (!policy) return false;
  if (policy.features.imports !== true || policy.features[kind.feature] !== true) return false;
  const held = new Set(policy.permissions.map((grant) => grant.permission));
  return ['import:run', ...kind.permissions].every((permission) => held.has(permission));
}

/**
 * Only one delivery works in the batch's transaction at a time, whatever the heartbeat says: a
 * delivery that was slow, not dead, still holds this until it ends.
 */
async function holdBatch(client: pg.PoolClient, batchId: string): Promise<boolean> {
  const { rows } = await client.query<{ held: boolean }>(
    "select pg_try_advisory_xact_lock(hashtextextended('import:' || $1, 0)) as held",
    [batchId],
  );
  return rows[0]?.held === true;
}

/**
 * Goes through every row of the batch: made into a body and checked as its create route would.
 * With `write`, a row that passes is written, and the first refusal ends it (the transaction may
 * be refused by the database from then on). Returns the problems, in the order of the lines.
 */
async function eachRow(
  pool: pg.Pool,
  job: BatchJob,
  claimed: Claim,
  kind: ImportKind,
  writer: Writer,
  write: boolean,
): Promise<LineProblem[]> {
  const minorDigits = minorDigitsOf(await currencyOfHospital(writer.txClient));
  const problems: LineProblem[] = [];
  const keys = new Set<string>();
  let after = 0;
  let done = 0;
  for (;;) {
    const rows = await readRows(writer.txClient, job.batchId, after, PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.line;
      const converted = convert(kind.columns, kind.body, row.values, minorDigits);
      if ('problems' in converted) {
        problems.push(...converted.problems.map((problem) => ({ ...problem, line: row.line })));
      } else {
        try {
          const prepared = await kind.prepare(writer, converted.body);
          if (keys.has(prepared.key)) problems.push({ line: row.line, code: 'duplicate_in_file' });
          else {
            keys.add(prepared.key);
            if (write) await kind.write(writer, prepared.value, claimed.actorId);
          }
        } catch (error) {
          problems.push({ ...problemOf(error), line: row.line });
        }
      }
      if (write && problems.length > 0) return problems;
    }
    done += rows.length;
    await progress(pool, job, claimed.token, done);
  }
  return problems;
}

/** Every row checked, nothing written, in a transaction that is rolled back. */
function dryRun(pool: pg.Pool, job: BatchJob, claimed: Claim, kind: ImportKind) {
  return atHospital(pool, job.tenantId, async (client) => {
    const writer = new JobWriter(client, claimed.actorId, job.batchId);
    throw new Rollback(await eachRow(pool, job, claimed, kind, writer, false));
  }) as Promise<LineProblem[]>;
}

/**
 * The dry run: every row checked as it would be written, and nothing written. The report of
 * problems replaces any earlier one, and the batch can then be written if it has none.
 */
export async function runCheck(pool: pg.Pool, kinds: ImportKinds, job: BatchJob): Promise<void> {
  const claimed = await claim(pool, job, 'checking');
  if (!claimed) return;
  try {
    const kind = kinds.get(claimed.kind);
    if (!kind) return await refuse(pool, job, claimed.token, 'unknown_kind');
    const allowed = await atHospital(pool, job.tenantId, (client) =>
      stillAllowed(client, job.tenantId, claimed.actorId, kind),
    );
    if (!allowed) return await refuse(pool, job, claimed.token, 'permission_withdrawn');
    const problems = await dryRun(pool, job, claimed, kind);
    await atHospital(pool, job.tenantId, async (client) => {
      if (
        !(await settle(client, job, claimed.token, {
          status: 'checked',
          problems: problems.length,
        }))
      ) {
        return;
      }
      await replaceProblems(client, job.batchId, problems);
      const writer = new JobWriter(client, claimed.actorId, job.batchId);
      writer.audit('check', 'import_batch', job.batchId);
      // What the check read of the hospital's records, as the create routes' checks are audited.
      if (kind.kind === 'patients') writer.audit('duplicate_check', 'patient');
      await writer.flush();
    });
  } catch (error) {
    await refuse(pool, job, claimed.token, 'check_failed').catch(() => undefined);
    throw error;
  }
}

/**
 * Writes the batch: every row, in one transaction, so the batch is all of its rows or none of
 * them. Each row is checked again first, since the records may have changed since the dry run. A
 * refusal rolls everything back; the rows are then checked again without writing, so the report
 * is whole, and the batch fails with it.
 */
export async function runCommit(pool: pg.Pool, kinds: ImportKinds, job: BatchJob): Promise<void> {
  const claimed = await claim(pool, job, 'queued');
  if (!claimed) return;
  try {
    const kind = kinds.get(claimed.kind);
    if (!kind) return await refuse(pool, job, claimed.token, 'unknown_kind');
    const outcome = await atHospital(
      pool,
      job.tenantId,
      async (client): Promise<'busy' | 'withdrawn' | 'written' | LineProblem[]> => {
        if (!(await holdBatch(client, job.batchId))) throw new Rollback('busy');
        if (!(await stillAllowed(client, job.tenantId, claimed.actorId, kind))) {
          throw new Rollback('withdrawn');
        }
        const writer = new JobWriter(client, claimed.actorId, job.batchId);
        const refused = await eachRow(pool, job, claimed, kind, writer, true);
        if (refused.length > 0) throw new Rollback(refused);
        if (!(await settle(client, job, claimed.token, { status: 'committed', problems: 0 }))) {
          throw new Rollback('busy');
        }
        await deleteRows(client, job.batchId);
        await client.query('delete from import_problems where batch_id = $1', [job.batchId]);
        writer.audit('commit', 'import_batch', job.batchId);
        if (kind.kind === 'patients') writer.audit('duplicate_check', 'patient');
        await writer.flush();
        return 'written';
      },
    );
    if (outcome === 'written' || outcome === 'busy') return;
    if (outcome === 'withdrawn')
      return await refuse(pool, job, claimed.token, 'permission_withdrawn');
    // The whole report, not only the row the writing stopped at.
    const report = await dryRun(pool, job, claimed, kind);
    const first = outcome[0];
    if (first && !report.some((problem) => problem.line === first.line)) {
      report.push(first);
      report.sort((a, b) => a.line - b.line);
    }
    await refuse(pool, job, claimed.token, 'rows_refused', report);
  } catch (error) {
    await refuse(pool, job, claimed.token, 'write_failed').catch(() => undefined);
    throw error;
  }
}
