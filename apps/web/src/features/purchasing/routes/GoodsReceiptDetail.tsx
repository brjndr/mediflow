import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button, buttonVariants } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { PurchasingLinks } from '../components/PurchasingLinks';
import { ReturnPanel } from '../components/ReturnPanel';
import { useReceipt, useReturns } from '../hooks/use-purchasing';
import type { GoodsReceiptLine, PurchaseReturn } from '../types';

/**
 * A goods receipt (`purchasing/receipts/:receiptId`, #103), for `purchaseOrder:read`: its order
 * and supplier, the supplier's invoice, where and when it came in, its batches with their expiry,
 * units, cost and printed price and what was sent back of each, and its returns. **Return to
 * supplier** (`purchaseReturn:create`) opens a panel in place. Works at every width.
 */
export default function GoodsReceiptDetail() {
  const { receiptId = '' } = useParams();
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const receipt = useReceipt(receiptId);
  const data = receipt.data;
  const returns = useReturns(receiptId);
  const returnRows = useMemo(
    () => returns.data?.pages.flatMap((page) => page.items) ?? [],
    [returns.data],
  );
  const mayReturn = usePermission('purchaseReturn:create');
  const returnsId = useId();
  const noneLeftId = useId();

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);
  const [returning, setReturning] = useState(false);
  usePanelFocus(returning ? 'return' : null, box, status);

  const columns = useMemo<GridColumn<GoodsReceiptLine>[]>(
    () => [
      {
        id: 'item',
        header: t('receipt.columns.item'),
        value: (row) => row.itemName,
        hideable: false,
      },
      {
        id: 'batch',
        header: t('receipt.columns.batch'),
        value: (row) =>
          t('receipt.batch', {
            number: row.batchNumber,
            expiry: format.calendarDate(row.expiryDate),
          }),
      },
      {
        id: 'units',
        header: t('receipt.columns.units'),
        value: (row) =>
          t('receipt.unitsAt', { count: row.quantity, price: format.money(row.unitCostMinor) }),
      },
      {
        id: 'amount',
        header: t('receipt.columns.amount'),
        value: (row) => format.money(row.unitCostMinor * row.quantity),
        align: 'end',
      },
      {
        id: 'mrp',
        header: t('receipt.columns.mrp'),
        value: (row) => (row.mrpMinor === undefined ? '' : format.money(row.mrpMinor)),
      },
      {
        id: 'returned',
        header: t('receipt.columns.returned'),
        value: (row) => t('receipt.returnedUnits', { count: row.returnedQuantity }),
      },
    ],
    [t, format],
  );

  const returnColumns = useMemo<GridColumn<PurchaseReturn>[]>(
    () => [
      {
        id: 'reference',
        header: t('returns.columns.reference'),
        value: (row) => row.reference,
        hideable: false,
      },
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

  if (receipt.isPending) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t('receipt.loading')}</p>;
  }
  if (!data) {
    const gone = isApiError(receipt.error) && receipt.error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('receipt.heading')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {gone ? t('receipt.notFound') : tCommon(errorMessageKey(receipt.error))}
        </p>
        <div className="flex flex-wrap gap-2">
          {!gone && (
            <Button type="button" onClick={() => void receipt.refetch()}>
              {t('retry')}
            </Button>
          )}
          <Link to="/purchasing/receipts" className={buttonVariants({ variant: 'outline' })}>
            {t('receipt.back')}
          </Link>
        </div>
      </div>
    );
  }
  const canReturn = data.lines.some((line) => line.quantity > line.returnedQuantity);

  return (
    <div ref={box} className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('receipt.headingOf', { reference: data.reference })}
        </h1>
        <PurchasingLinks />
      </div>
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none"
      >
        {message.text}
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-[auto_1fr]">
        <dt className="font-medium">{t('receipt.order')}</dt>
        <dd>
          <Link to={`/purchasing/orders/${data.orderId}`} className="underline underline-offset-4">
            {data.orderReference}
          </Link>
        </dd>
        <dt className="font-medium">{t('receipt.supplier')}</dt>
        <dd>{data.supplierName}</dd>
        {data.supplierInvoice && (
          <>
            <dt className="font-medium">{t('receipt.invoice')}</dt>
            <dd>{data.supplierInvoice}</dd>
          </>
        )}
        <dt className="font-medium">{t('receipt.received')}</dt>
        <dd>
          {t('receipt.receivedAt', {
            name: data.receivedByName,
            place: data.locationName,
            time: format.dateTime(data.receivedAt),
          })}
        </dd>
        {data.note && (
          <>
            <dt className="font-medium">{t('receipt.note')}</dt>
            <dd className="break-words">{data.note}</dd>
          </>
        )}
      </dl>
      <p className="font-semibold">
        {t('receipt.total', { total: format.money(data.totalMinor) })}
      </p>
      <Can permission="purchaseReturn:create">
        {!returning && (
          <div>
            <Button
              type="button"
              variant="outline"
              aria-disabled={!canReturn || undefined}
              aria-describedby={canReturn ? undefined : noneLeftId}
              onClick={() => {
                if (canReturn) setReturning(true);
              }}
            >
              {t('receipt.returnItems')}
            </Button>
            {!canReturn && (
              <p id={noneLeftId} className="mt-1 text-sm text-muted-foreground">
                {t('receipt.noneLeft')}
              </p>
            )}
          </div>
        )}
      </Can>
      {returning && mayReturn && (
        <ReturnPanel
          receipt={data}
          onClose={() => setReturning(false)}
          onReturned={(back) => {
            setReturning(false);
            say(t('return.done', { reference: back.reference }));
          }}
        />
      )}
      <DataGrid
        label={t('receipt.lines')}
        columns={columns}
        rows={data.lines}
        rowId={(row) => row.id}
        rowLabel={(row) => `${row.itemName} ${row.batchNumber}`}
        status="ready"
        emptyMessage={t('receipt.noLines')}
      />
      <section aria-labelledby={returnsId} className="flex flex-col gap-2">
        <h2 id={returnsId} className="text-lg font-semibold">
          {t('receipt.returns')}
        </h2>
        <DataGrid
          label={t('receipt.returns')}
          columns={returnColumns}
          rows={returnRows}
          rowId={(row) => row.id}
          rowLabel={(row) => row.reference}
          status={returns.isPending ? 'loading' : returns.isError ? 'error' : 'ready'}
          errorMessage={returns.isError ? tCommon(errorMessageKey(returns.error)) : undefined}
          onRetry={() => void returns.refetch()}
          emptyMessage={t('receipt.noReturns')}
          hasNextPage={returns.hasNextPage && !returns.isPlaceholderData}
          loadingMore={returns.isFetchingNextPage}
          onLoadMore={() => void returns.fetchNextPage()}
        />
      </section>
    </div>
  );
}
