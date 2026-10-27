import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { PurchasingLinks } from '../components/PurchasingLinks';
import { useReceipts } from '../hooks/use-purchasing';
import type { GoodsReceiptSummary } from '../types';

/**
 * Goods receipts (`purchasing/receipts`, #103), for `purchaseOrder:read`: the newest first, each
 * with its order, supplier, the supplier's invoice, where it came in, its total and who received
 * it. **Open** shows one. Works at every width.
 */
export default function GoodsReceipts() {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const receipts = useReceipts();
  const rows = useMemo(
    () => receipts.data?.pages.flatMap((page) => page.items) ?? [],
    [receipts.data],
  );
  const total = receipts.isPlaceholderData ? undefined : receipts.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<GoodsReceiptSummary>[]>(
    () => [
      {
        id: 'reference',
        header: t('receipts.columns.reference'),
        value: (row) => row.reference,
        hideable: false,
      },
      { id: 'order', header: t('receipts.columns.order'), value: (row) => row.orderReference },
      { id: 'supplier', header: t('receipts.columns.supplier'), value: (row) => row.supplierName },
      {
        id: 'invoice',
        header: t('receipts.columns.invoice'),
        value: (row) => row.supplierInvoice ?? '',
      },
      { id: 'place', header: t('receipts.columns.place'), value: (row) => row.locationName },
      {
        id: 'total',
        header: t('receipts.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      {
        id: 'received',
        header: t('receipts.columns.received'),
        value: (row) =>
          t('receipts.receivedBy', {
            name: row.receivedByName,
            time: format.dateTime(row.receivedAt),
          }),
      },
    ],
    [t, format],
  );
  const actions: GridAction<GoodsReceiptSummary>[] = [
    {
      id: 'open',
      label: t('receipts.open'),
      onSelect: (row) => navigate(`/purchasing/receipts/${row.id}`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('receipts.heading')}</h1>
        <PurchasingLinks />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('receipts.count', { count: total })}
      </p>
      <DataGrid
        label={t('receipts.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.reference}
        actions={actions}
        status={receipts.isPending ? 'loading' : receipts.isError ? 'error' : 'ready'}
        errorMessage={receipts.isError ? tCommon(errorMessageKey(receipts.error)) : undefined}
        onRetry={() => void receipts.refetch()}
        emptyMessage={t('receipts.empty')}
        hasNextPage={receipts.hasNextPage && !receipts.isPlaceholderData}
        total={total}
        loadingMore={receipts.isFetchingNextPage}
        onLoadMore={() => void receipts.fetchNextPage()}
      />
    </div>
  );
}
