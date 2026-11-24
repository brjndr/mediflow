import { ReceiptText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { Card } from '@/shared/ui/card';
import { WidgetHeading, WidgetLink } from '@/shared/ui/stat-card';
import { Skeleton } from '@/shared/ui/skeleton';
import { useFormatters, useTenant } from '@/tenancy';
import { fetchReport } from '../api';
import { reportKeys } from '../hooks/use-reports';
import { sumColumn } from '../lib/sum-column';

const loadHindi = () => import('../widget-strings.hi.json');

/**
 * Issued invoices not fully paid: how many and how much is due, from the `outstanding` report (a
 * snapshot of now, totals only, no patient). Links to the invoice list filtered to issued.
 * Default export: a `dashboard.widgets` contribution.
 */
export default function UnpaidInvoicesWidget() {
  const { t } = useWidgetStrings('reports-widget', widgetStrings, loadHindi);
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
        <WidgetHeading id="widget-unpaid" title={t('unpaid.title')} icon={ReceiptText} accent={4} />
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
            <p className="font-display text-3xl font-semibold tabular-nums md:text-4xl">
              {format.money(sumColumn(report.data, 'dueMinor'))}
            </p>
            <p className="text-sm text-muted-foreground">{t('unpaid.count', { count })}</p>
          </>
        )}
        <WidgetLink to="/billing/invoices?status=issued">{t('unpaid.open')}</WidgetLink>
      </section>
    </Card>
  );
}
