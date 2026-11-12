import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { useFormatters, useTenant } from '@/tenancy';
import { fetchReport } from '../api';
import { reportKeys } from '../hooks/use-reports';
import { sumColumn } from '../lib/sum-column';

/**
 * Issued invoices not fully paid: how many and how much is due, from the `outstanding` report (a
 * snapshot of now, totals only, no patient). Links to the invoice list filtered to issued.
 * Default export: a `dashboard.widgets` contribution.
 */
export default function UnpaidInvoicesWidget() {
  const { t } = useWidgetStrings('reports-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();

  const report = useQuery({
    queryKey: reportKeys.detail(tenant?.id ?? '', 'unpaid-now'),
    queryFn: ({ signal }) => fetchReport('outstanding', {}, signal),
    enabled: tenant !== undefined,
    staleTime: 60_000,
  });

  const count = report.data ? sumColumn(report.data, 'invoices') : 0;

  return (
    <Card asChild>
      <section aria-labelledby="widget-unpaid" className="flex flex-col gap-2">
        <h2 id="widget-unpaid" className="text-sm font-medium">
          {t('unpaid.title')}
        </h2>
        {report.isError ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {tCommon(errorMessageKey(report.error))}
          </p>
        ) : !report.data ? (
          <Skeleton className="h-16 w-full" />
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground">{t('unpaid.empty')}</p>
        ) : (
          <>
            <p className="text-3xl font-semibold tabular-nums">
              {format.money(sumColumn(report.data, 'dueMinor'))}
            </p>
            <p className="text-sm text-muted-foreground">{t('unpaid.count', { count })}</p>
          </>
        )}
        <Link
          to="/billing/invoices?status=issued"
          className="mt-auto inline-flex text-sm underline underline-offset-4 pointer-coarse:min-h-11 pointer-coarse:items-center"
        >
          {t('unpaid.open')}
        </Link>
      </section>
    </Card>
  );
}
