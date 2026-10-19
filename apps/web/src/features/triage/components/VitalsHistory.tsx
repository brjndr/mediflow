import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useVitalRanges, useVitals } from '../hooks/use-triage';
import type { Vitals } from '../types';
import { useReadingLines, type ReadingLine } from '../hooks/use-reading-lines';
import { FlagMark, RangesNote } from './reading';

/** The patient's readings, newest first, a page at a time, with corrections marked. */
export function VitalsHistory({ patientId }: { patientId: string }) {
  const { t } = useTranslation('triage');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const canRecord = usePermission('vitals:record');
  const vitals = useVitals(patientId);
  const ranges = useVitalRanges(patientId);
  const linesOf = useReadingLines();
  const headingId = useId();
  const rows = useMemo(() => vitals.data?.pages.flatMap((page) => page.items) ?? [], [vitals.data]);
  const total = vitals.data?.pages[0]?.total;
  // Readings a later one corrects, among those loaded: the original is kept and marked.
  const corrected = useMemo(
    () => new Set(rows.flatMap((row) => (row.correctsId ? [row.correctsId] : []))),
    [rows],
  );

  const columns = useMemo<GridColumn<Vitals>[]>(() => {
    const range = ranges.data?.ranges;
    // Each row's lines once, not once a cell.
    const lines = new Map(rows.map((row) => [row.id, linesOf(row, range)]));
    const line = (row: Vitals, id: ReadingLine['id']) =>
      lines.get(row.id)?.find((each) => each.id === id);
    const measured = (id: ReadingLine['id'], header: string): GridColumn<Vitals> => ({
      id,
      header,
      value: (row) => line(row, id)?.text ?? '',
      render: (row, text) => {
        const flag = line(row, id)?.flag;
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            {text}
            {flag && <FlagMark flag={flag} />}
          </span>
        );
      },
    });
    return [
      {
        id: 'recordedAt',
        header: t('history.columns.recordedAt'),
        value: (row) => format.dateTime(row.recordedAt),
        hideable: false,
        render: (row, text) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            {text}
            {corrected.has(row.id) && (
              <span className="rounded bg-muted px-1.5 text-xs">{t('history.corrected')}</span>
            )}
            {row.correctsId && (
              <span className="rounded bg-muted px-1.5 text-xs">{t('history.correction')}</span>
            )}
          </span>
        ),
      },
      measured('pressure', t('history.columns.pressure')),
      measured('pulse', t('history.columns.pulse')),
      measured('temperature', t('history.columns.temperature')),
      measured('spo2', t('history.columns.spo2')),
      measured('weight', t('history.columns.weight')),
      measured('height', t('history.columns.height')),
      {
        id: 'complaint',
        header: t('history.columns.complaint'),
        value: (row) => row.chiefComplaint ?? '',
      },
      { id: 'by', header: t('history.columns.by'), value: (row) => row.recordedByName },
    ];
  }, [t, format, linesOf, ranges.data, corrected, rows]);

  const actions = useMemo<GridAction<Vitals>[]>(
    () => [
      {
        id: 'correct',
        label: t('history.correct'),
        requires: 'vitals:record',
        // A reading already corrected is corrected again from its correction.
        disabled: (row) => corrected.has(row.id),
        onSelect: (row) => navigate(`/triage/${patientId}?corrects=${row.id}`),
      },
    ],
    [t, navigate, patientId, corrected],
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('history.heading')}
        </h2>
        {canRecord && (
          <Button asChild variant="outline" size="sm">
            <Link to={`/triage/${patientId}`}>{t('history.record')}</Link>
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('history.count', { count: total })}
      </p>
      <RangesNote ranges={ranges.data?.ranges} failed={ranges.isError} />
      <DataGrid
        label={t('history.label')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('history.rowLabel', { time: format.dateTime(row.recordedAt) })}
        actions={actions}
        status={vitals.isPending ? 'loading' : vitals.isError ? 'error' : 'ready'}
        errorMessage={vitals.isError ? tCommon(errorMessageKey(vitals.error)) : undefined}
        onRetry={() => void vitals.refetch()}
        emptyMessage={t('history.empty')}
        hasNextPage={vitals.hasNextPage}
        total={total}
        loadingMore={vitals.isFetchingNextPage}
        onLoadMore={() => void vitals.fetchNextPage()}
      />
    </section>
  );
}
