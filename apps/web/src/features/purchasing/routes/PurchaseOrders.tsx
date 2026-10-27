import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { buttonVariants } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { field } from '../components/field';
import { PurchasingLinks } from '../components/PurchasingLinks';
import { useOrders } from '../hooks/use-purchasing';
import { ORDER_STATUSES } from '../schemas';
import type { PurchaseOrderStatus, PurchaseOrderSummary } from '../types';

/**
 * Purchase orders (`purchasing`, #103), for `purchaseOrder:read`: the newest first, of every
 * status or one, each with its supplier, where it goes, its lines and total, and who drafted it.
 * **New purchase order** (`purchaseOrder:create`); **Open** shows one. Works at every width.
 */
export default function PurchaseOrders() {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const statusFieldId = useId();
  const [status, setStatus] = useState<PurchaseOrderStatus | ''>('');
  const orders = useOrders(status);
  const rows = useMemo(() => orders.data?.pages.flatMap((page) => page.items) ?? [], [orders.data]);
  const total = orders.isPlaceholderData ? undefined : orders.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<PurchaseOrderSummary>[]>(
    () => [
      {
        id: 'reference',
        header: t('orders.columns.reference'),
        value: (row) => row.reference,
        hideable: false,
      },
      { id: 'supplier', header: t('orders.columns.supplier'), value: (row) => row.supplierName },
      {
        id: 'status',
        header: t('orders.columns.status'),
        value: (row) => t(`status.${row.status}`),
      },
      {
        id: 'lines',
        header: t('orders.columns.lines'),
        value: (row) => t('orders.lineCount', { count: row.lineCount }),
      },
      {
        id: 'total',
        header: t('orders.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      { id: 'place', header: t('orders.columns.place'), value: (row) => row.locationName },
      {
        id: 'created',
        header: t('orders.columns.created'),
        value: (row) =>
          t('orders.createdBy', { name: row.createdByName, time: format.dateTime(row.createdAt) }),
      },
    ],
    [t, format],
  );

  const actions: GridAction<PurchaseOrderSummary>[] = [
    {
      id: 'open',
      label: t('orders.open'),
      onSelect: (row) => navigate(`/purchasing/orders/${row.id}`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('orders.heading')}</h1>
        <PurchasingLinks />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <label htmlFor={statusFieldId} className="text-sm font-medium">
            {t('orders.show')}
          </label>
          <select
            id={statusFieldId}
            className={field}
            value={status}
            onChange={(event) => setStatus(event.target.value as PurchaseOrderStatus | '')}
          >
            <option value="">{t('orders.every')}</option>
            {ORDER_STATUSES.map((each) => (
              <option key={each} value={each}>
                {t(`status.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <Can permission="purchaseOrder:create">
          <Link to="/purchasing/orders/new" className={buttonVariants()}>
            {t('orders.new')}
          </Link>
        </Can>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('orders.count', { count: total })}
      </p>
      <DataGrid
        label={t('orders.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.reference}
        actions={actions}
        status={orders.isPending ? 'loading' : orders.isError ? 'error' : 'ready'}
        errorMessage={orders.isError ? tCommon(errorMessageKey(orders.error)) : undefined}
        onRetry={() => void orders.refetch()}
        emptyMessage={t('orders.empty')}
        hasNextPage={orders.hasNextPage && !orders.isPlaceholderData}
        total={total}
        loadingMore={orders.isFetchingNextPage}
        onLoadMore={() => void orders.fetchNextPage()}
      />
    </div>
  );
}
