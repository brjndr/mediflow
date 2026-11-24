import { Minus, Stethoscope, TrendingDown, TrendingUp } from 'lucide-react';
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
import { shiftDay } from '../schemas';
import type { ReportResult } from '../types';

const loadHindi = () => import('../widget-strings.hi.json');

/** One number of a report's line for `day`; 0 when the day or the column is missing. */
function cellOf(report: ReportResult, day: string, key: string): number {
  const at = report.columns.findIndex((column) => column.key === key);
  const row = report.rows.find((each) => each[0] === day);
  return at < 0 || !row ? 0 : Number(row[at] ?? 0);
}

/**
 * OPD visits opened today (the hospital's day) against yesterday by this time of day, and the
 * consultations done against today's booked appointments, from one `opd_progress` report over
 * yesterday and today: counts only, never a patient (#1124). Default export: a
 * `dashboard.widgets` contribution.
 */
export default function VisitsTodayWidget() {
  const { t } = useWidgetStrings('reports-widget', widgetStrings, loadHindi);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const today = todayIn(tenant?.timezone ?? 'UTC');
  const yesterday = shiftDay(today, -1);

  const report = useQuery({
    queryKey: reportKeys.detail(tenant?.id ?? '', `visits-${today}`),
    queryFn: ({ signal }) => fetchReport('opd_progress', { from: yesterday, to: today }, signal),
    enabled: tenant !== undefined,
    staleTime: 60_000,
  });

  const data = report.data;
  const opened = data ? cellOf(data, today, 'opened') : 0;
  const change = data ? opened - cellOf(data, yesterday, 'openedByNow') : 0;
  const done = data ? cellOf(data, today, 'consultationsDone') : 0;
  const booked = data ? cellOf(data, today, 'booked') : 0;
  // Walk-ins can take the consultations past the bookings: the bar is then full. With nothing
  // booked there is no bar, only words.
  const most = Math.max(booked, done);
  const Trend = change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus;
  const trend =
    change > 0
      ? t('visits.more', { count: change, n: format.number(change) })
      : change < 0
        ? t('visits.fewer', { count: -change, n: format.number(-change) })
        : t('visits.same');
  const ofBooked = t('visits.ofBooked', {
    done: format.number(done),
    booked: format.number(booked),
  });

  return (
    <Card asChild>
      <section aria-labelledby="widget-visits" className="flex flex-col gap-2">
        <WidgetHeading id="widget-visits" title={t('visits.title')} icon={Stethoscope} accent={3} />
        {report.isError ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {tCommon(errorMessageKey(report.error))}
          </p>
        ) : !data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">{t('visits.opened')}</dt>
              <dd className="font-display text-3xl font-semibold tabular-nums md:text-4xl">
                {format.number(opened)}
              </dd>
              <dd className="flex items-center gap-1.5 text-sm">
                <Trend aria-hidden className="size-4 shrink-0" />
                {trend}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt id="widget-visits-done" className="text-sm text-muted-foreground">
                {t('visits.done')}
              </dt>
              <dd className="font-display text-3xl font-semibold tabular-nums md:text-4xl">
                {format.number(done)}
              </dd>
              {booked === 0 ? (
                <dd className="text-sm">{t('visits.noneBooked')}</dd>
              ) : (
                <dd className="flex flex-col gap-1.5">
                  <div
                    role="progressbar"
                    aria-labelledby="widget-visits-done"
                    aria-valuemin={0}
                    aria-valuemax={most}
                    aria-valuenow={done}
                    aria-valuetext={ofBooked}
                    className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(done / most) * 100}%` }}
                    />
                  </div>
                  <span className="text-sm">{ofBooked}</span>
                </dd>
              )}
            </div>
          </dl>
        )}
      </section>
    </Card>
  );
}
