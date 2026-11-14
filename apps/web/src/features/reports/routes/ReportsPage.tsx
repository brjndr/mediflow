import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { focusIfLost } from '@/shared/lib/focus';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { OutstandingInvoices } from '../components/OutstandingInvoices';
import { ReportForm, type Intent } from '../components/ReportForm';
import { ReportTable } from '../components/ReportTable';
import { startDownload } from '../download';
import { reportErrorText } from '../errors';
import {
  useDownloadLink,
  reportKeys,
  useLimits,
  useRequestRun,
  useRun,
  useRuns,
  useSpotReport,
} from '../hooks/use-reports';
import {
  AGE_BANDS,
  daysIncluded,
  shiftDay,
  SNAPSHOT_KINDS,
  SPOT_MAX_DAYS,
  type RequestValues,
} from '../schemas';
import type { AgeBand, ReportResult, ReportRun } from '../types';

/** What the table below the form shows: the report just worked out, or a stored run's. */
type Viewing = { type: 'spot' } | { type: 'run'; id: string };

function Reports() {
  const { t } = useTranslation('reports');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const intentRef = useRef<Intent>('show');
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;

  const spot = useSpotReport();
  const request = useRequestRun();
  const download = useDownloadLink();
  const runs = useRuns();
  const limits = useLimits();
  const [viewing, setViewing] = useState<Viewing | null>(null);
  // The age band of the outstanding report whose invoices are open under the table.
  const [band, setBand] = useState<AgeBand | null>(null);
  const run = useRun(viewing?.type === 'run' ? viewing.id : null);

  // The status line is always on the page, so a saved, refused or finished state is announced.
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  // The export the person asked for and is waiting on: the line says so when it ends. Anything
  // else said meanwhile (a download started, a refusal) takes the line instead.
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const say = (text: string) => {
    setWaitingFor(null);
    setMessage((now) => ({ text, count: now.count + 1 }));
  };
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const followed = viewing?.type === 'run' ? run.data : undefined;
  const ended =
    waitingFor !== null &&
    followed?.id === waitingFor &&
    (followed.status === 'succeeded' || followed.status === 'failed')
      ? followed
      : undefined;
  const endedText = !ended
    ? ''
    : ended.status === 'succeeded'
      ? t('status.ready')
      : t('status.failed', { reason: t(`failure.${ended.failure ?? 'failed'}`) });
  // The list and the quota show that it ended too.
  const endedId = ended?.id;
  useEffect(() => {
    if (endedId && tenantId) {
      void queryClient.invalidateQueries({ queryKey: reportKeys.all(tenantId) });
    }
  }, [endedId, tenantId, queryClient]);

  const onSubmit = async (values: RequestValues, how: Intent) => {
    const snapshot = SNAPSHOT_KINDS.includes(values.kind);
    const days = snapshot ? {} : { from: values.from, to: values.to };
    try {
      if (how === 'show') {
        if (!snapshot && daysIncluded(values.from, values.to) > SPOT_MAX_DAYS) {
          say(t('errors.range_too_long'));
          return;
        }
        const result = await spot.mutateAsync({ kind: values.kind, ...days });
        setViewing({ type: 'spot' });
        say(t('status.shown', { count: result.rows.length }));
      } else {
        const created = await request.mutateAsync({ kind: values.kind, ...days });
        setViewing({ type: 'run', id: created.id });
        say(t('status.queued'));
        setWaitingFor(created.id);
      }
    } catch (error) {
      say(reportErrorText(error, t, tCommon));
    }
  };

  const columns = useMemo<GridColumn<ReportRun>[]>(
    () => [
      {
        id: 'kind',
        header: t('runs.columns.report'),
        value: (row) => t(`kinds.${row.kind}`),
        hideable: false,
      },
      {
        id: 'period',
        header: t('runs.columns.period'),
        value: (row) =>
          row.from && row.to
            ? t('runs.period', {
                from: format.calendarDate(row.from),
                to: format.calendarDate(row.to),
              })
            : t('runs.snapshot'),
      },
      {
        id: 'requested',
        header: t('runs.columns.requested'),
        value: (row) => format.dateTime(row.requestedAt),
      },
      { id: 'by', header: t('runs.columns.by'), value: (row) => row.requestedBy.name },
      {
        id: 'status',
        header: t('runs.columns.status'),
        value: (row) => t(`runStatus.${row.status}`),
      },
      {
        id: 'rows',
        header: t('runs.columns.rows'),
        value: (row) => (row.rowCount === undefined ? '' : format.number(row.rowCount)),
        align: 'end',
      },
      {
        id: 'expires',
        header: t('runs.columns.expires'),
        value: (row) => format.date(row.expiresAt),
      },
    ],
    [t, format],
  );

  const actions = useMemo<GridAction<ReportRun>[]>(
    () => [
      {
        id: 'view',
        label: t('runs.view'),
        disabled: (row) => row.status !== 'succeeded',
        onSelect: (row) => setViewing({ type: 'run', id: row.id }),
      },
      {
        id: 'download',
        label: t('runs.download'),
        requires: 'report:export',
        disabled: (row) => row.status !== 'succeeded' || download.isPending,
        onSelect: (row) => {
          download.mutate(row.id, {
            onSuccess: (link) => {
              startDownload(link.url);
              say(t('status.downloading'));
            },
            onError: (error) => say(reportErrorText(error, t, tCommon)),
          });
        },
      },
    ],
    [t, tCommon, download],
  );

  const rows = useMemo(() => runs.data?.pages.flatMap((page) => page.items) ?? [], [runs.data]);
  const total = runs.isPlaceholderData ? undefined : runs.data?.pages[0]?.total;

  let shown: ReportResult | undefined;
  let working = false;
  let failed: string | undefined;
  if (viewing?.type === 'spot') shown = spot.data;
  if (viewing?.type === 'run') {
    shown = run.data?.result;
    working = run.data?.status === 'queued' || run.data?.status === 'running';
    failed = run.data?.status === 'failed' ? (run.data.failure ?? 'failed') : undefined;
  }

  const pending = spot.isPending || request.isPending;
  const limit = limits.data;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
      <ReportForm
        initial={{ kind: 'opd_census', from: shiftDay(today, -6), to: today }}
        intentRef={intentRef}
        pending={pending}
        onSubmit={onSubmit}
      />
      {limit && (
        <p className="text-sm text-muted-foreground">
          {t('limits', {
            active: limit.active,
            max: limit.maxConcurrent,
            used: limit.usedToday,
            perDay: limit.maxPerDay,
            days: limit.retentionDays,
          })}
        </p>
      )}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {endedText || message.text}
      </p>
      {working && <p className="text-sm">{t('status.working')}</p>}
      {failed && <p className="text-sm text-destructive">{t(`failure.${failed}`)}</p>}
      {shown && (
        <section aria-labelledby="report-result" className="flex flex-col gap-2">
          <h2 id="report-result" className="text-lg font-semibold">
            {t(`kinds.${shown.kind}`)}
          </h2>
          <p className="text-sm text-muted-foreground">
            {shown.from && shown.to
              ? t('result.period', {
                  from: format.calendarDate(shown.from),
                  to: format.calendarDate(shown.to),
                  at: format.dateTime(shown.generatedAt),
                })
              : t('result.snapshot', { at: format.dateTime(shown.generatedAt) })}
          </p>
          <ReportTable
            result={shown}
            label={t(`kinds.${shown.kind}`)}
            {...(shown.kind === 'outstanding'
              ? {
                  openLabel: t('drilldown.open'),
                  onOpenRow: (key: string) => {
                    const next = AGE_BANDS.find((each) => each === key);
                    if (next) setBand(next);
                  },
                }
              : {})}
          />
          {shown.kind === 'outstanding' && band && <OutstandingInvoices band={band} />}
        </section>
      )}
      <section aria-labelledby="report-runs" className="flex flex-col gap-2">
        <h2 id="report-runs" className="text-lg font-semibold">
          {t('runs.heading')}
        </h2>
        <DataGrid
          label={t('runs.heading')}
          columns={columns}
          rows={rows}
          rowId={(row) => row.id}
          rowLabel={(row) => t(`kinds.${row.kind}`)}
          actions={actions}
          status={runs.isPending ? 'loading' : runs.isError ? 'error' : 'ready'}
          errorMessage={runs.isError ? tCommon(errorMessageKey(runs.error)) : undefined}
          onRetry={() => void runs.refetch()}
          emptyMessage={t('runs.empty')}
          hasNextPage={runs.hasNextPage && !runs.isPlaceholderData}
          total={total}
          loadingMore={runs.isFetchingNextPage}
          onLoadMore={() => void runs.fetchNextPage()}
        />
      </section>
    </div>
  );
}

/** Reports (`reports`, #121): a desktop screen, since a report is a wide table. */
export default function ReportsPage() {
  return (
    <DesktopOnly>
      <Reports />
    </DesktopOnly>
  );
}
