import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import type { TaskMove } from '../api';
import { RequestCleaning } from '../components/RequestCleaning';
import { useMoveTask, useTasks, useWardOptions } from '../hooks/use-tasks';
import { allowedMoves, TASK_STATUSES } from '../schemas';
import type { CleaningTask, CleaningTaskStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/** Refusals this screen has words for, as keys of the feature's strings. */
function refusalKey(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.serverCode === 'conflict' || error.serverCode === 'invalid_transition') {
    return 'refused.changed';
  }
  if (error.serverCode === 'feature_disabled') return 'refused.wardsOff';
  return null;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function CleaningTasks() {
  const { t } = useTranslation('housekeeping');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [status, setStatus] = useState<CleaningTaskStatus>('open');
  const [wardId, setWardId] = useState('');
  const tasks = useTasks(status, wardId);
  // Needs ward:read: a role without it simply gets no ward filter.
  const wards = useWardOptions(true);
  const move = useMoveTask();
  const [done, setDone] = useState<{ text: string; at: number }>();
  const [requesting, setRequesting] = useState(false);
  const statusLine = useRef<HTMLParagraphElement>(null);
  // A row that moved on has left the filtered list and may have taken focus with it.
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = useMemo(() => tasks.data?.pages.flatMap((page) => page.items) ?? [], [tasks.data]);
  const total = tasks.data?.pages[0]?.total;

  const run = async (next: TaskMove, task: CleaningTask) => {
    move.reset();
    setDone(undefined);
    try {
      await move.mutateAsync(next);
      setDone({ text: t(`done.${next.to}`, { number: task.bedNumber }), at: Date.now() });
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const pending = move.isPending;
  const actions: GridAction<CleaningTask>[] = [
    {
      id: 'start',
      label: t('actions.start'),
      requires: 'cleaningTask:work',
      disabled: (row) => pending || !allowedMoves(row.status).start,
      onSelect: (row) => void run({ task: row, to: 'in_progress' }, row),
    },
    {
      id: 'finish',
      label: t('actions.finish'),
      requires: 'cleaningTask:work',
      disabled: (row) => pending || !allowedMoves(row.status).finish,
      onSelect: (row) => void run({ task: row, to: 'done' }, row),
    },
    {
      id: 'cancel',
      label: t('actions.cancel'),
      requires: 'cleaningTask:manage',
      disabled: (row) => pending || !allowedMoves(row.status).cancel,
      onSelect: (row) => void run({ task: row, to: 'cancelled' }, row),
    },
  ];

  const columns = useMemo<GridColumn<CleaningTask>[]>(
    () => [
      { id: 'bed', header: t('columns.bed'), value: (row) => row.bedNumber, hideable: false },
      { id: 'ward', header: t('columns.ward'), value: (row) => row.wardName },
      { id: 'kind', header: t('columns.kind'), value: (row) => t(`kind.${row.kind}`) },
      {
        id: 'status',
        header: t('columns.status'),
        value: (row) => t(`status.${row.status}`),
        hideable: false,
      },
      {
        id: 'assignedTo',
        header: t('columns.assignedTo'),
        value: (row) => row.assignedToName ?? '',
      },
      {
        id: 'created',
        header: t('columns.created'),
        value: (row) => format.dateTime(row.createdAt),
      },
    ],
    [t, format],
  );

  const refused = refusalKey(move.error);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <Can permission="cleaningTask:manage">
          <Button onClick={() => setRequesting(true)}>{t('request.open')}</Button>
        </Can>
      </div>
      {requesting && (
        <RequestCleaning
          onClose={() => setRequesting(false)}
          onRequested={(number) => {
            setRequesting(false);
            setDone({ text: t('done.requested', { number }), at: Date.now() });
          }}
        />
      )}

      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-52 flex-col gap-1 text-sm font-medium sm:w-60">
          {t('filters.status')}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as CleaningTaskStatus)}
            className={control}
          >
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {wards.data && (
          <label className="flex min-w-52 flex-col gap-1 text-sm font-medium sm:w-60">
            {t('filters.ward')}
            <select
              value={wardId}
              onChange={(event) => setWardId(event.target.value)}
              className={control}
            >
              <option value="">{t('filters.allWards')}</option>
              {wards.data.map((ward) => (
                <option key={ward.id} value={ward.id}>
                  {ward.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {move.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(move.error))}
        </p>
      )}
      {/* Always on the page, so a screen reader reads what is put in it; focusable, so focus has
          somewhere to go when the row it was on leaves the list. */}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done?.text ?? ''}
      </p>

      <p className="text-sm text-muted-foreground">
        {total === undefined || tasks.isPlaceholderData ? '' : t('count', { count: total })}
      </p>
      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { number: row.bedNumber, ward: row.wardName })}
        actions={tasks.isPlaceholderData ? [] : actions}
        status={tasks.isPending ? 'loading' : tasks.isError ? 'error' : 'ready'}
        errorMessage={tasks.isError ? tCommon(errorMessageKey(tasks.error)) : undefined}
        onRetry={() => void tasks.refetch()}
        emptyMessage={t('empty')}
        hasNextPage={tasks.hasNextPage && !tasks.isPlaceholderData}
        total={tasks.isPlaceholderData ? undefined : total}
        loadingMore={tasks.isFetchingNextPage}
        onLoadMore={() => void tasks.fetchNextPage()}
      />
    </div>
  );
}
