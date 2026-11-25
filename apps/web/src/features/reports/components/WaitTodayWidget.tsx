import { Timer } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { Card } from '@/shared/ui/card';
import { WidgetHeading } from '@/shared/ui/stat-card';
import { Skeleton } from '@/shared/ui/skeleton';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { fetchReport } from '../api';
import { reportKeys } from '../hooks/use-reports';
import type { ReportResult } from '../types';

const loadHindi = () => import('../widget-strings.hi.json');

type Wait = {
  average: number;
  started: number;
  notStarted: number;
  /** The median over every department's tokens, worked out by the server. */
  median?: number;
  longest?: { department: string; minutes: number };
};

/** The wait over every department, weighted by the consultations each started, from `opd_wait`. */
function summarize(report: ReportResult): Wait {
  const at = (key: string) => report.columns.findIndex((column) => column.key === key);
  const [department, started, avg, notStarted] = [
    at('department'),
    at('started'),
    at('avgWaitMinutes'),
    at('notStarted'),
  ];
  const medianAt = at('dayMedianWaitMinutes');
  const dayMedian = medianAt < 0 ? null : report.rows[0]?.[medianAt];
  let weighted = 0;
  let count = 0;
  let waiting = 0;
  let longest: Wait['longest'];
  for (const row of report.rows) {
    const n = Number(row[started] ?? 0);
    const minutes = row[avg] === null || row[avg] === undefined ? null : Number(row[avg]);
    waiting += Number(row[notStarted] ?? 0);
    if (minutes === null || n === 0) continue;
    weighted += minutes * n;
    count += n;
    if (!longest || minutes > longest.minutes) {
      longest = { department: String(row[department] ?? ''), minutes };
    }
  }
  return {
    average: count === 0 ? 0 : Math.round(weighted / count),
    started: count,
    notStarted: waiting,
    median: dayMedian === null || dayMedian === undefined ? undefined : Number(dayMedian),
    longest,
  };
}

/**
 * The average wait from a token being issued to its consultation starting today (the hospital's
 * day), the department with the longest wait, and the tokens not yet seen, from the `opd_wait`
 * report: durations and counts only, never a patient (#1125). Default export: a
 * `dashboard.widgets` contribution.
 */
export default function WaitTodayWidget() {
  const { t } = useWidgetStrings('reports-widget', widgetStrings, loadHindi);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const today = todayIn(tenant?.timezone ?? 'UTC');

  const report = useQuery({
    queryKey: reportKeys.detail(tenant?.id ?? '', `wait-${today}`),
    queryFn: ({ signal }) => fetchReport('opd_wait', { from: today, to: today }, signal),
    enabled: tenant !== undefined,
    staleTime: 60_000,
  });

  const wait = report.data ? summarize(report.data) : undefined;
  const minutes = (n: number) => t('wait.minutes', { count: n, n: format.number(n) });

  return (
    <Card asChild>
      <section aria-labelledby="widget-wait" className="flex flex-col gap-2">
        <WidgetHeading id="widget-wait" title={t('wait.title')} icon={Timer} accent={2} />
        {report.isError ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {tCommon(errorMessageKey(report.error))}
          </p>
        ) : !wait ? (
          <Skeleton className="h-16 w-full" />
        ) : wait.started === 0 ? (
          <p className="text-sm text-muted-foreground">{t('wait.empty')}</p>
        ) : (
          <dl className="flex flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{t('wait.average')}</dt>
            <dd className="font-display text-3xl font-semibold tabular-nums md:text-4xl">
              {minutes(wait.average)}
            </dd>
            {wait.median !== undefined ? (
              <dd className="text-sm">{t('wait.median', { minutes: minutes(wait.median) })}</dd>
            ) : null}
            {wait.longest ? (
              <dd className="text-sm">
                {t('wait.longest', {
                  department: wait.longest.department,
                  minutes: minutes(wait.longest.minutes),
                })}
              </dd>
            ) : null}
            {wait.notStarted > 0 ? (
              <dd className="text-sm text-muted-foreground">
                {t('wait.notStarted', { n: format.number(wait.notStarted) })}
              </dd>
            ) : null}
          </dl>
        )}
      </section>
    </Card>
  );
}
