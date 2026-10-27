import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { PharmacyLinks } from '../components/PharmacyLinks';
import { useQueue } from '../hooks/use-pharmacy';
import { QUEUE_DAYS_DEFAULT, QUEUE_WINDOWS } from '../schemas';
import type { PharmacyQueueItem, QueueState } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * The pharmacy's queue (`pharmacy`, #100), for `dispense:read`: the prescriptions with a line
 * still to dispense, the oldest first, or those dispensed, the newest first, within a window of
 * days. Each opens its prescription, where its lines are dispensed. Works at every width.
 */
export default function PharmacyQueue() {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const stateFieldId = useId();
  const daysFieldId = useId();
  const [state, setState] = useState<QueueState>('open');
  const [days, setDays] = useState<number>(QUEUE_DAYS_DEFAULT);
  const queue = useQueue({ state, days });
  const rows = useMemo(() => queue.data?.pages.flatMap((page) => page.items) ?? [], [queue.data]);
  const total = queue.isPlaceholderData ? undefined : queue.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<PharmacyQueueItem>[]>(
    () => [
      {
        id: 'patient',
        header: t('queue.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('queue.columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      {
        id: 'lines',
        header: t('queue.columns.lines'),
        value: (row) =>
          state === 'open'
            ? t('queue.toDispense', { count: row.openLineCount, total: row.lineCount })
            : t('queue.lineCount', { count: row.lineCount }),
      },
      {
        id: 'progress',
        header: t('queue.columns.progress'),
        value: (row) =>
          t(
            row.openLineCount === 0
              ? 'queue.progress.done'
              : row.startedLineCount > 0
                ? 'queue.progress.partly'
                : 'queue.progress.new',
          ),
      },
      {
        id: 'prescribed',
        header: t('queue.columns.prescribed'),
        value: (row) =>
          t('queue.prescribedBy', {
            time: format.dateTime(row.prescribedAt),
            name: row.prescribedByName,
          }),
      },
    ],
    [t, format, state],
  );

  const actions: GridAction<PharmacyQueueItem>[] = [
    {
      id: 'open',
      label: t(state === 'open' ? 'queue.dispense' : 'queue.view'),
      onSelect: (row) => navigate(`/pharmacy/prescriptions/${row.prescriptionId}`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <PharmacyLinks />
      <h1 className="text-2xl font-semibold tracking-tight">{t('queue.heading')}</h1>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:max-w-xl">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={stateFieldId} className="text-sm font-medium">
            {t('queue.state')}
          </label>
          <select
            id={stateFieldId}
            className={field}
            value={state}
            onChange={(event) => setState(event.target.value as QueueState)}
          >
            <option value="open">{t('queue.states.open')}</option>
            <option value="done">{t('queue.states.done')}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={daysFieldId} className="text-sm font-medium">
            {t('queue.days')}
          </label>
          <select
            id={daysFieldId}
            className={field}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {QUEUE_WINDOWS.map((each) => (
              <option key={each} value={each}>
                {t('queue.window', { count: each })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('queue.count', { count: total })}
      </p>
      <DataGrid
        label={t('queue.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.prescriptionId}
        rowLabel={(row) => t('queue.rowLabel', { name: row.patientName })}
        actions={actions}
        status={queue.isPending ? 'loading' : queue.isError ? 'error' : 'ready'}
        errorMessage={queue.isError ? tCommon(errorMessageKey(queue.error)) : undefined}
        onRetry={() => void queue.refetch()}
        emptyMessage={t(`queue.empty.${state}`)}
        hasNextPage={queue.hasNextPage && !queue.isPlaceholderData}
        total={total}
        loadingMore={queue.isFetchingNextPage}
        onLoadMore={() => void queue.fetchNextPage()}
      />
    </div>
  );
}
