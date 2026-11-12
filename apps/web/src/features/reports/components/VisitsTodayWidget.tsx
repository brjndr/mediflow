import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { fetchReport } from '../api';
import { reportKeys } from '../hooks/use-reports';
import { sumColumn } from '../lib/sum-column';

/**
 * OPD visits opened and closed today (the hospital's day), from the `opd_census` report: counts
 * by department, never a patient. Default export: a `dashboard.widgets` contribution.
 */
export default function VisitsTodayWidget() {
  const { t } = useWidgetStrings('reports-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const today = todayIn(tenant?.timezone ?? 'UTC');

  const report = useQuery({
    queryKey: reportKeys.detail(tenant?.id ?? '', `visits-${today}`),
    queryFn: ({ signal }) => fetchReport('opd_census', { from: today, to: today }, signal),
    enabled: tenant !== undefined,
    staleTime: 60_000,
  });

  return (
    <Card asChild>
      <section aria-labelledby="widget-visits" className="flex flex-col gap-2">
        <h2 id="widget-visits" className="text-sm font-medium">
          {t('visits.title')}
        </h2>
        {report.isError ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {tCommon(errorMessageKey(report.error))}
          </p>
        ) : !report.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-2">
            <div>
              <dt className="text-sm text-muted-foreground">{t('visits.opened')}</dt>
              <dd className="text-3xl font-semibold tabular-nums">
                {format.number(sumColumn(report.data, 'opened'))}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('visits.closed')}</dt>
              <dd className="text-3xl font-semibold tabular-nums">
                {format.number(sumColumn(report.data, 'closed'))}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </Card>
  );
}
