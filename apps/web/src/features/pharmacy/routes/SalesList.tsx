import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { buttonVariants } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { PharmacyLinks } from '../components/PharmacyLinks';
import { useSales } from '../hooks/use-sales';
import { QUEUE_DAYS_DEFAULT, QUEUE_WINDOWS } from '../schemas';
import type { SaleListItem } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Counter sales (`pharmacy/sales`, #101), for `sale:read`: the hospital's sales within a window
 * of days, the newest first, each with who it was for (an over-the-counter sale may name nobody),
 * its total and what was returned. **New sale** (`sale:create`) sells; **View** opens a sale.
 * Works at every width.
 */
export default function SalesList() {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const daysFieldId = useId();
  const [days, setDays] = useState<number>(QUEUE_DAYS_DEFAULT);
  const sales = useSales(days);
  const rows = useMemo(() => sales.data?.pages.flatMap((page) => page.items) ?? [], [sales.data]);
  const total = sales.isPlaceholderData ? undefined : sales.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<SaleListItem>[]>(
    () => [
      {
        id: 'sold',
        header: t('sales.columns.sold'),
        value: (row) => format.dateTime(row.soldAt),
        hideable: false,
      },
      {
        id: 'patient',
        header: t('sales.columns.patient'),
        value: (row) => row.patientName ?? t('sales.walkIn'),
      },
      {
        id: 'mrn',
        header: t('sales.columns.mrn'),
        value: (row) => row.patientMrn ?? '',
        mask: maskMrn,
      },
      {
        id: 'items',
        header: t('sales.columns.lines'),
        value: (row) => t('sales.lineCount', { count: row.lineCount }),
      },
      {
        id: 'total',
        header: t('sales.columns.total'),
        value: (row) =>
          row.returnedMinor === '0'
            ? format.money(Number(row.totalMinor))
            : t('sales.totalReturned', {
                total: format.money(Number(row.totalMinor)),
                returned: format.money(Number(row.returnedMinor)),
              }),
      },
      {
        id: 'by',
        header: t('sales.columns.by'),
        value: (row) => t('sales.soldBy', { name: row.soldByName, place: row.locationName }),
      },
    ],
    [t, format],
  );

  const actions: GridAction<SaleListItem>[] = [
    {
      id: 'open',
      label: t('sales.view'),
      onSelect: (row) => navigate(`/pharmacy/sales/${row.id}`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <PharmacyLinks />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('sales.heading')}</h1>
        <Can permission="sale:create">
          <Link to="/pharmacy/sales/new" className={buttonVariants()}>
            {t('sales.new')}
          </Link>
        </Can>
      </div>
      <div className="flex flex-col gap-1.5 md:max-w-xs">
        <label htmlFor={daysFieldId} className="text-sm font-medium">
          {t('sales.days')}
        </label>
        <select
          id={daysFieldId}
          className={field}
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
        >
          {QUEUE_WINDOWS.map((each) => (
            <option key={each} value={each}>
              {t('queue.window', { count: each })}
            </option>
          ))}
        </select>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('sales.count', { count: total })}
      </p>
      <DataGrid
        label={t('sales.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('sales.rowLabel', { time: format.dateTime(row.soldAt) })}
        actions={actions}
        status={sales.isPending ? 'loading' : sales.isError ? 'error' : 'ready'}
        errorMessage={sales.isError ? tCommon(errorMessageKey(sales.error)) : undefined}
        onRetry={() => void sales.refetch()}
        emptyMessage={t('sales.empty')}
        hasNextPage={sales.hasNextPage && !sales.isPlaceholderData}
        total={total}
        loadingMore={sales.isFetchingNextPage}
        onLoadMore={() => void sales.fetchNextPage()}
      />
    </div>
  );
}
