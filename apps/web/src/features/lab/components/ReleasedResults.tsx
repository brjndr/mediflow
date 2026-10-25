import { TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useAcknowledgeResult, usePatientResults } from '../hooks/use-lab';
import { rangeWords } from '../range-words';
import { needsAcknowledging } from '../schemas';
import type { LabResult } from '../types';
import { AcknowledgementWords } from './AcknowledgementWords';
import { ResultFlag } from './ResultFlag';
import { ResultTrend } from './ResultTrend';

/**
 * A patient's released results (#92), the newest collected first: all of them (the patient's
 * tab, with each numeric test's trend) or one encounter's (the consultation). Each names the
 * test (a link to its order's results), the value as entered with its unit, the API's flag, the
 * range, when it was collected and who verified it. A critical result not yet acknowledged says
 * so in words with an icon, and `labResult:acknowledge` acknowledges it. The caller checks
 * `labResult:read` and the switch.
 */
export function ReleasedResults({
  patientId,
  encounterId,
  label,
  withTrend = false,
}: {
  patientId: string;
  encounterId?: string;
  /** Names the list; the section around it has the same heading. */
  label: string;
  withTrend?: boolean;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const results = usePatientResults({ patientId, ...(encounterId ? { encounterId } : {}) });
  const acknowledge = useAcknowledgeResult();
  const rows = useMemo(
    () => results.data?.pages.flatMap((page) => page.items) ?? [],
    [results.data],
  );
  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  const [trend, setTrend] = useState<LabResult | null>(null);
  usePanelFocus(trend ? `trend:${trend.labTestId}` : null, box, status);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const waiting = rows.filter(needsAcknowledging).length;

  const columns = useMemo<GridColumn<LabResult>[]>(() => {
    const number = (value: number) => format.number(value);
    return [
      {
        id: 'test',
        header: t('released.columns.test'),
        value: (row) => row.testName,
        hideable: false,
        render: (row, text) => (
          <Link
            to={`/lab/orders/${row.orderId}`}
            className="text-primary underline underline-offset-4 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            {text}
          </Link>
        ),
      },
      {
        id: 'result',
        header: t('results.columns.result'),
        value: (row) => [row.value, row.unit].filter(Boolean).join(' '),
        render: (row, text) => <span className="font-medium whitespace-pre-line">{text}</span>,
      },
      {
        id: 'flag',
        header: t('results.columns.flag'),
        value: (row) => (row.flag ? t(`flag.${row.flag}`) : ''),
        render: (row) => <ResultFlag flag={row.flag} />,
      },
      {
        id: 'range',
        header: t('results.columns.range'),
        value: (row) => rangeWords(row.range, t, number),
      },
      {
        id: 'collected',
        header: t('released.columns.collected'),
        value: (row) => format.dateTime(row.collectedAt),
      },
      {
        id: 'state',
        header: t('results.columns.state'),
        value: (row) =>
          [
            t('results.verifiedBy', {
              name: row.verifiedByName ?? '',
              time: row.verifiedAt ? format.dateTime(row.verifiedAt) : '',
            }),
            row.amendsId ? t('released.corrected') : '',
          ]
            .filter(Boolean)
            .join(' '),
        render: (row, text) => (
          <span className="flex flex-col gap-0.5">
            <span>{text}</span>
            <AcknowledgementWords result={row} />
          </span>
        ),
      },
    ];
  }, [t, format]);

  const actions: GridAction<LabResult>[] = [
    {
      id: 'acknowledge',
      label: t('acknowledge.action'),
      requires: 'labResult:acknowledge',
      disabled: (row) => !needsAcknowledging(row) || acknowledge.isPending,
      onSelect: (row) => {
        if (!needsAcknowledging(row) || acknowledge.isPending) return;
        acknowledge.mutate(row, {
          onSuccess: (done) => say(t('acknowledge.done', { name: done.testName })),
          onError: (error) =>
            say(
              isApiError(error) && error.serverCode === 'already_acknowledged'
                ? t('acknowledge.already', { name: row.testName })
                : isApiError(error) && error.serverCode === 'not_acknowledgeable'
                  ? t('acknowledge.notAcknowledgeable', { name: row.testName })
                  : tCommon(errorMessageKey(error)),
            ),
        });
      },
    },
    ...(withTrend
      ? [
          {
            id: 'trend',
            label: t('trend.action'),
            disabled: (row: LabResult) => row.resultType !== 'numeric',
            onSelect: (row: LabResult) => {
              if (row.resultType === 'numeric') setTrend(row);
            },
          },
        ]
      : []),
  ];

  return (
    <div ref={box} className="flex flex-col gap-3">
      {waiting > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-destructive p-3 text-sm font-semibold text-destructive">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('acknowledge.waiting', { count: waiting })}
        </p>
      )}
      {/* Always on the page, so what was done is read when it is said. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* A new node per message, so the same words said twice are announced twice. */}
        {message.text && <span key={message.count}>{message.text}</span>}
      </p>
      {trend && (
        <ResultTrend
          key={trend.labTestId}
          patientId={patientId}
          labTestId={trend.labTestId}
          name={trend.testName}
          unit={trend.unit}
          onClose={() => setTrend(null)}
        />
      )}
      <DataGrid
        label={label}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) =>
          t('released.rowLabel', { name: row.testName, time: format.dateTime(row.collectedAt) })
        }
        actions={actions}
        status={results.isPending ? 'loading' : results.isError ? 'error' : 'ready'}
        errorMessage={results.isError ? tCommon(errorMessageKey(results.error)) : undefined}
        onRetry={() => void results.refetch()}
        emptyMessage={t('released.empty')}
        hasNextPage={results.hasNextPage}
        loadingMore={results.isFetchingNextPage}
        onLoadMore={() => void results.fetchNextPage()}
      />
    </div>
  );
}
