import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { TimeSeriesChart } from '@/shared/ui/charts';
import { Skeleton } from '@/shared/ui/skeleton';
import { useFormatters } from '@/tenancy';
import { TREND_SIZE, useResultTrend } from '../hooks/use-lab';
import { rangeWords } from '../range-words';

/**
 * One numeric test of a patient over time (#92): its released results, oldest to newest by when
 * the sample was collected, as a line with a dot per result and, for anyone, the same numbers as
 * a table. The newest hundred at most. The range said under it is the newest result's, as a
 * patient's range moves with their age.
 */
export function ResultTrend({
  patientId,
  labTestId,
  name,
  unit,
  onClose,
}: {
  patientId: string;
  labTestId: string;
  name: string;
  unit: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const trend = useResultTrend(patientId, labTestId);
  const items = trend.data?.items;
  const points = useMemo(
    () =>
      [...(items ?? [])]
        .reverse()
        .map((result) => ({
          label: format.dateTime(result.collectedAt),
          value: Number(result.value),
        }))
        .filter((point) => Number.isFinite(point.value)),
    [items, format],
  );
  const newest = items?.[0];
  const range = rangeWords(newest?.range, t, (value) => format.number(value));
  const valueHeader = unit ? t('trend.valueWithUnit', { unit }) : t('trend.value');

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3
          id={headingId}
          tabIndex={-1}
          data-panel-heading
          className="font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {t('trend.heading', { name })}
        </h3>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {t('trend.close')}
        </Button>
      </div>
      {trend.isPending ? (
        <Skeleton className="h-60 w-full" />
      ) : trend.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm">
            {tCommon(errorMessageKey(trend.error))}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void trend.refetch()}>
            {t('results.retry')}
          </Button>
        </div>
      ) : points.length < 2 ? (
        <p className="text-sm text-muted-foreground">{t('trend.tooFew')}</p>
      ) : (
        <>
          <TimeSeriesChart
            title={t('trend.heading', { name })}
            labelHeader={t('released.columns.collected')}
            valueHeader={valueHeader}
            data={points}
            formatValue={(value) => format.number(value)}
            dots
          />
          {range && <p className="text-sm">{t('trend.range', { range })}</p>}
          {trend.data.nextCursor && (
            <p className="text-sm text-muted-foreground">
              {t('trend.newestOnly', { count: TREND_SIZE })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
