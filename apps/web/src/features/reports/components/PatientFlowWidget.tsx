import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { todayIn } from '@/shared/utils/timezone';
import { Card } from '@/shared/ui/card';
import { CategoryBarChart } from '@/shared/ui/charts';
import { Skeleton } from '@/shared/ui/skeleton';
import { useFormatters, useTenant } from '@/tenancy';
import { fetchReport } from '../api';
import { reportKeys } from '../hooks/use-reports';

/**
 * OPD visits opened in each hour of today, from the `opd_hourly` report (counts only, no patient),
 * between the first and the last busy hour. Default export: contributed to the `dashboard.widgets`
 * slot through the manifest.
 */
export default function PatientFlowWidget() {
  const { t } = useWidgetStrings('reports-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const timezone = tenant?.timezone ?? 'UTC';
  const today = todayIn(timezone);

  const report = useQuery({
    queryKey: reportKeys.detail(tenant?.id ?? '', `flow-hourly-${today}`),
    queryFn: ({ signal }) => fetchReport('opd_hourly', { from: today, to: today }, signal),
    enabled: tenant !== undefined,
    staleTime: 60_000,
  });

  const data = useMemo(() => {
    if (!report.data) return undefined;
    const hourAt = report.data.columns.findIndex((column) => column.key === 'hour');
    const openedAt = report.data.columns.findIndex((column) => column.key === 'opened');
    if (hourAt < 0 || openedAt < 0) return [];
    const byHour = new Map<number, number>();
    for (const row of report.data.rows) {
      const hour = Number(row[hourAt]);
      byHour.set(hour, (byHour.get(hour) ?? 0) + Number(row[openedAt] ?? 0));
    }
    const busy = [...byHour.entries()].filter(([, value]) => value > 0).map(([hour]) => hour);
    if (busy.length === 0) return [];
    const first = Math.min(...busy);
    const last = Math.max(...busy);
    return Array.from({ length: last - first + 1 }, (_, index) => ({
      hour: first + index,
      value: byHour.get(first + index) ?? 0,
    }));
  }, [report.data]);

  const total = data?.reduce((sum, point) => sum + point.value, 0) ?? 0;
  const busiest = data?.reduce((best, point) => (point.value > best.value ? point : best));
  const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  const points = data?.map((point) => ({
    label: hourLabel(point.hour),
    value: point.value,
  }));

  return (
    <Card asChild>
      <section aria-labelledby="widget-flow" className="flex flex-col gap-2">
        <h2 id="widget-flow" className="text-sm font-medium">
          {t('flow.title')}
        </h2>
        {report.isError ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {tCommon(errorMessageKey(report.error))}
          </p>
        ) : !points ? (
          <Skeleton className="h-48 w-full" />
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">{t('flow.empty')}</p>
        ) : (
          <CategoryBarChart
            title={t('flow.title')}
            labelHeader={t('flow.day')}
            valueHeader={t('flow.visits')}
            data={points}
            formatValue={(value) => format.number(value)}
            height={192}
            emphasize={busiest && busiest.value > 0 ? hourLabel(busiest.hour) : undefined}
            summary={
              busiest
                ? t('flow.summary', {
                    hour: hourLabel(busiest.hour),
                    count: busiest.value,
                  })
                : undefined
            }
          />
        )}
      </section>
    </Card>
  );
}
