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

const DAYS = 7;
const DAY_MS = 86_400_000;

/** The calendar day `back` days before `day`; noon UTC keeps daylight-saving shifts out of it. */
const daysBefore = (day: string, back: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) - back * DAY_MS).toISOString().slice(0, 10);

/**
 * OPD visits opened on each of the last seven days, from the `opd_census` report (counts by day
 * and department; it holds no patient). Hourly flow needs an endpoint the API does not have yet.
 * Default export: contributed to the `dashboard.widgets` slot through the manifest.
 */
export default function PatientFlowWidget() {
  const { t } = useWidgetStrings('reports-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const timezone = tenant?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const days = useMemo(
    () => Array.from({ length: DAYS }, (_, index) => daysBefore(today, DAYS - 1 - index)),
    [today],
  );
  const from = days[0] ?? today;

  const report = useQuery({
    queryKey: reportKeys.detail(tenant?.id ?? '', `flow-${from}-${today}`),
    queryFn: ({ signal }) => fetchReport('opd_census', { from, to: today }, signal),
    enabled: tenant !== undefined,
    staleTime: 60_000,
  });

  const data = useMemo(() => {
    if (!report.data) return undefined;
    const dayAt = report.data.columns.findIndex((column) => column.key === 'day');
    const openedAt = report.data.columns.findIndex((column) => column.key === 'opened');
    if (dayAt < 0 || openedAt < 0) return [];
    const byDay = new Map<string, number>();
    for (const row of report.data.rows) {
      const day = String(row[dayAt]);
      byDay.set(day, (byDay.get(day) ?? 0) + Number(row[openedAt] ?? 0));
    }
    return days.map((day) => ({ day, value: byDay.get(day) ?? 0 }));
  }, [report.data, days]);

  const total = data?.reduce((sum, point) => sum + point.value, 0) ?? 0;
  const busiest = data?.reduce((best, point) => (point.value > best.value ? point : best));
  const points = data?.map((point) => ({
    label: format.calendarDate(point.day),
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
            emphasize={busiest && busiest.value > 0 ? format.calendarDate(busiest.day) : undefined}
            summary={
              busiest
                ? t('flow.summary', {
                    day: format.calendarDate(busiest.day),
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
