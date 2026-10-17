import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { useFormatters } from '@/tenancy';
import { link, useFieldName, useKindName } from '../components/common';
import { useBatchAction, useImportBatch, useImportProblems } from '../hooks/use-imports';
import { WORKING } from '../schemas';
import type { ImportBatch, ImportProblem } from '../types';

/** Refusals of an action on a batch that have words of their own. */
const KNOWN_REFUSALS = ['import_running', 'import_not_ready', 'import_busy', 'import_not_staging'];

const KNOWN_FAILURES = [
  'stalled',
  'rows_refused',
  'permission_withdrawn',
  'write_failed',
  'check_failed',
  'unknown_kind',
  'expired',
];

/** What the batch is doing now, in a sentence, with a progress bar while a job works on it. */
function State({
  batch,
  statusLine,
}: {
  batch: ImportBatch;
  /** The line that says how the batch ended, which focus goes to when a button goes away. */
  statusLine: RefObject<HTMLParagraphElement>;
}) {
  const { t } = useTranslation('imports');
  const working = batch.status === 'checking' || batch.status === 'running';
  const sentence = (() => {
    switch (batch.status) {
      case 'checking':
        return t('batch.progressChecking', { done: batch.doneCount, total: batch.rowCount });
      case 'running':
        return t('batch.progressRunning', { done: batch.doneCount, total: batch.rowCount });
      case 'queued':
        return t('batch.queued');
      case 'staging':
        return t('batch.staging');
      case 'checked':
        return batch.problemCount === 0
          ? t('batch.checkedClean')
          : t('batch.checkedProblems', { count: batch.problemCount });
      case 'committed':
        return t('batch.committed', { count: batch.doneCount });
      case 'cancelled':
        return batch.failure === 'expired' ? t('failures.expired') : t('batch.cancelled');
      case 'failed':
        return t(
          `failures.${batch.failure && KNOWN_FAILURES.includes(batch.failure) ? batch.failure : 'other'}`,
        );
    }
  })();
  return (
    <div className="flex max-w-xl flex-col gap-2">
      <p className="text-sm">
        <span className="font-medium">{t(`statuses.${batch.status}`)}</span>
      </p>
      {working && (
        <progress
          className="h-2 w-full"
          value={batch.doneCount}
          max={Math.max(batch.rowCount, 1)}
          aria-label={sentence}
        />
      )}
      {/* The progress is shown, not said at every step: it changes every second. */}
      {working && <p className="text-sm">{sentence}</p>}
      {/* Always there, so how the job ended is read when it is said. */}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {working ? '' : sentence}
      </p>
    </div>
  );
}

/** What is wrong with which line and field. Codes only: the file's values are not on the server. */
function Report({ batch }: { batch: ImportBatch }) {
  const { t, i18n } = useTranslation('imports');
  const { t: tCommon } = useTranslation();
  const fieldName = useFieldName();
  const problems = useImportProblems(batch);
  const rows = useMemo(
    () => problems.data?.pages.flatMap((page) => page.items) ?? [],
    [problems.data],
  );
  const columns = useMemo<GridColumn<ImportProblem>[]>(
    () => [
      {
        id: 'line',
        header: t('batch.line'),
        value: (row) => String(row.line),
        hideable: false,
      },
      {
        id: 'field',
        header: t('batch.field'),
        value: (row) => (row.field ? fieldName(batch.kind, row.field) : t('batch.wholeRow')),
      },
      {
        id: 'problem',
        header: t('batch.problem'),
        value: (row) =>
          i18n.exists(`problems.${row.code}`, { ns: 'imports' })
            ? t(`problems.${row.code}`)
            : t('problems.other'),
      },
    ],
    [t, i18n, fieldName, batch.kind],
  );
  return (
    <section aria-labelledby="import-report" className="flex flex-col gap-3">
      <h2 id="import-report" className="text-lg font-semibold">
        {t('batch.reportHeading')}
      </h2>
      <DataGrid
        label={t('batch.reportLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => `${row.line}-${row.field ?? ''}-${row.code}`}
        rowLabel={(row) => `${t('batch.line')} ${row.line}`}
        status={problems.isPending ? 'loading' : problems.isError ? 'error' : 'ready'}
        errorMessage={problems.isError ? tCommon(errorMessageKey(problems.error)) : undefined}
        onRetry={() => void problems.refetch()}
        emptyMessage={t('batch.reportEmpty')}
        hasNextPage={problems.hasNextPage}
        loadingMore={problems.isFetchingNextPage}
        onLoadMore={() => void problems.fetchNextPage()}
      />
    </section>
  );
}

function Batch({ batchId }: { batchId: string }) {
  const { t } = useTranslation('imports');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const kindName = useKindName();
  const batch = useImportBatch(batchId);
  const action = useBatchAction(batchId);
  // Writing or giving up takes the buttons away: the keyboard goes to the line that says how the
  // batch stands, unless the person has moved it meanwhile.
  const statusLine = useRef<HTMLParagraphElement>(null);
  const status = batch.data?.status;
  useEffect(() => {
    focusIfLost(statusLine.current);
  }, [status, action.isError]);

  if (batch.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {tCommon('app.loading')}
      </p>
    );
  }
  if (batch.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {tCommon(errorMessageKey(batch.error))}
      </p>
    );
  }
  const current = batch.data;
  const writable = current.status === 'checked' && current.problemCount === 0;
  const cancellable = current.status === 'staging' || current.status === 'checked';
  const showReport = current.problemCount > 0 && !WORKING.includes(current.status);

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('batch.heading', { kind: kindName(current.kind) })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('batch.started', {
            name: current.createdBy.name,
            date: format.dateTime(current.createdAt),
          })}{' '}
          {t('batch.rows', { count: current.rowCount })}
        </p>
      </div>
      <State batch={current} statusLine={statusLine} />
      <Can permission="import:run">
        {(writable || cancellable) && (
          <div className="flex flex-wrap gap-3">
            {writable && (
              <Button
                aria-disabled={action.isPending || undefined}
                aria-busy={action.isPending}
                onClick={() => action.mutate('commit')}
              >
                {action.isPending && action.variables === 'commit'
                  ? t('batch.committing')
                  : t('batch.commit')}
              </Button>
            )}
            {cancellable && (
              <Button
                variant="outline"
                aria-disabled={action.isPending || undefined}
                onClick={() => action.mutate('cancel')}
              >
                {t('batch.cancel')}
              </Button>
            )}
          </div>
        )}
      </Can>
      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(action.error) &&
          action.error.serverCode !== undefined &&
          KNOWN_REFUSALS.includes(action.error.serverCode)
            ? t(`refusals.${action.error.serverCode}`)
            : tCommon(errorMessageKey(action.error))}
        </p>
      )}
      {showReport && <Report batch={current} />}
    </>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ImportDetail() {
  const { t } = useTranslation('imports');
  const { batchId = '' } = useParams();
  return (
    <DesktopOnly>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        <Link to="/imports" className={`${link} text-sm underline`}>
          {t('backToList')}
        </Link>
        <Batch batchId={batchId} />
      </div>
    </DesktopOnly>
  );
}
