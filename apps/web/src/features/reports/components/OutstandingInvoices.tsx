import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useOutstandingInvoices } from '../hooks/use-reports';
import type { AgeBand, OutstandingInvoice } from '../types';

/**
 * The invoices behind one age band of the outstanding report, oldest first, paged by the server.
 * An invoice number, its age and amounts: the API names no patient here.
 */
export function OutstandingInvoices({ band }: { band: AgeBand }) {
  const { t } = useTranslation('reports');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const query = useOutstandingInvoices(band);

  const columns = useMemo<GridColumn<OutstandingInvoice>[]>(
    () => [
      {
        id: 'number',
        header: t('drilldown.columns.number'),
        value: (row) => row.number,
        hideable: false,
      },
      {
        id: 'issued',
        header: t('drilldown.columns.issued'),
        value: (row) => format.date(row.issuedAt),
      },
      {
        id: 'age',
        header: t('drilldown.columns.age'),
        value: (row) => t('drilldown.days', { count: row.ageDays }),
        align: 'end',
      },
      {
        id: 'total',
        header: t('drilldown.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      {
        id: 'due',
        header: t('drilldown.columns.due'),
        value: (row) => format.money(row.dueMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const label = t('drilldown.heading', { band: t(`values.ageBucket.${band}`) });

  return (
    <section aria-labelledby="outstanding-invoices" className="flex flex-col gap-2">
      <h2 id="outstanding-invoices" className="text-lg font-semibold">
        {label}
      </h2>
      <DataGrid
        label={label}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.number}
        status={query.isPending ? 'loading' : query.isError ? 'error' : 'ready'}
        errorMessage={query.isError ? tCommon(errorMessageKey(query.error)) : undefined}
        onRetry={() => void query.refetch()}
        emptyMessage={t('drilldown.empty')}
        hasNextPage={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </section>
  );
}
