import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { PurchasingLinks } from '../components/PurchasingLinks';
import { useReturns } from '../hooks/use-purchasing';
import type { PurchaseReturn } from '../types';

/**
 * Returns to suppliers (`purchasing/returns`, #103), for `purchaseOrder:read`: the newest first,
 * each with its receipt, supplier, place, reason, the batches and units sent back, its total at
 * their received cost and who sent them. **Open receipt** shows the receipt. Works at every
 * width.
 */
export default function PurchaseReturns() {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const returns = useReturns();
  const rows = useMemo(
    () => returns.data?.pages.flatMap((page) => page.items) ?? [],
    [returns.data],
  );
  const total = returns.isPlaceholderData ? undefined : returns.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<PurchaseReturn>[]>(
    () => [
      {
        id: 'reference',
        header: t('returns.columns.reference'),
        value: (row) => row.reference,
        hideable: false,
      },
      { id: 'receipt', header: t('returns.columns.receipt'), value: (row) => row.receiptReference },
      { id: 'supplier', header: t('returns.columns.supplier'), value: (row) => row.supplierName },
      {
        id: 'reason',
        header: t('returns.columns.reason'),
        value: (row) =>
          row.note ? `${t(`reason.${row.reason}`)}: ${row.note}` : t(`reason.${row.reason}`),
      },
      {
        id: 'items',
        header: t('returns.columns.items'),
        value: (row) =>
          row.lines
            .map((line) =>
              t('returns.line', {
                count: line.quantity,
                name: line.itemName,
                number: line.batchNumber,
              }),
            )
            .join('; '),
      },
      {
        id: 'total',
        header: t('returns.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      {
        id: 'returned',
        header: t('returns.columns.returned'),
        value: (row) =>
          t('returns.returnedFrom', {
            name: row.returnedByName,
            place: row.locationName,
            time: format.dateTime(row.returnedAt),
          }),
      },
    ],
    [t, format],
  );
  const actions: GridAction<PurchaseReturn>[] = [
    {
      id: 'receipt',
      label: t('returns.openReceipt'),
      onSelect: (row) => navigate(`/purchasing/receipts/${row.receiptId}`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('returns.heading')}</h1>
        <PurchasingLinks />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('returns.count', { count: total })}
      </p>
      <DataGrid
        label={t('returns.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.reference}
        actions={actions}
        status={returns.isPending ? 'loading' : returns.isError ? 'error' : 'ready'}
        errorMessage={returns.isError ? tCommon(errorMessageKey(returns.error)) : undefined}
        onRetry={() => void returns.refetch()}
        emptyMessage={t('returns.empty')}
        hasNextPage={returns.hasNextPage && !returns.isPlaceholderData}
        total={total}
        loadingMore={returns.isFetchingNextPage}
        onLoadMore={() => void returns.fetchNextPage()}
      />
    </div>
  );
}
