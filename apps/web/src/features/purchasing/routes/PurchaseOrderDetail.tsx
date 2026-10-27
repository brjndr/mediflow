import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button, buttonVariants } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { EndOrderPanel } from '../components/EndOrderPanel';
import { PurchasingLinks } from '../components/PurchasingLinks';
import { ReceivePanel } from '../components/ReceivePanel';
import { ORDER_REFUSED } from '../components/refusals';
import { useOrder, useReceipts, useStepOrder } from '../hooks/use-purchasing';
import type { GoodsReceiptSummary, PurchaseOrderLine } from '../types';

type Panel = 'receive' | 'cancel' | 'close';

/**
 * A purchase order (`purchasing/orders/:orderId`, #103), for `purchaseOrder:read`: its supplier,
 * where it goes, its steps (drafted, submitted, approved, ended) with who and when, its lines
 * with what has been received of each, and its goods receipts. By its step: **Edit** and
 * **Submit** a draft, **Approve** a submitted one (`purchaseOrder:approve`, `aria-disabled` on
 * one's own), **Receive goods** against an approved one (`goodsReceipt:create`), **Cancel** one
 * nothing came in for and **Close** one partly received. Works at every width.
 */
export default function PurchaseOrderDetail() {
  const { orderId = '' } = useParams();
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useSession()?.user.id;
  const order = useOrder(orderId);
  const data = order.data;
  const receipts = useReceipts(orderId);
  const receiptRows = useMemo(
    () => receipts.data?.pages.flatMap((page) => page.items) ?? [],
    [receipts.data],
  );
  const canCreate = usePermission('purchaseOrder:create');
  const canApprove = usePermission('purchaseOrder:approve');
  const canReceive = usePermission('goodsReceipt:create');
  const receiptsId = useId();
  const ownId = useId();

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  // Arriving from the form that saved it, it says so.
  const saved = (location.state as { saved?: 'drafted' | 'edited' } | null)?.saved;
  const [message, setMessage] = useState({
    text: saved ? t(`order.saved.${saved}`) : '',
    count: 0,
  });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);
  const [panel, setPanel] = useState<Panel | null>(null);
  usePanelFocus(panel, box, status);

  const step = useStepOrder();
  const stepFailure = step.error
    ? isApiError(step.error) && ORDER_REFUSED[step.error.serverCode ?? '']
      ? t(ORDER_REFUSED[step.error.serverCode ?? ''] ?? '')
      : tCommon(errorMessageKey(step.error))
    : undefined;

  const columns = useMemo<GridColumn<PurchaseOrderLine>[]>(
    () => [
      {
        id: 'item',
        header: t('order.columns.item'),
        value: (row) => row.itemName,
        hideable: false,
      },
      {
        id: 'ordered',
        header: t('order.columns.ordered'),
        value: (row) => t('order.unitsOf', { count: row.quantity }),
      },
      {
        id: 'cost',
        header: t('order.columns.unitCost'),
        value: (row) => format.money(row.unitCostMinor),
        align: 'end',
      },
      {
        id: 'amount',
        header: t('order.columns.amount'),
        value: (row) => format.money(row.unitCostMinor * row.quantity),
        align: 'end',
      },
      {
        id: 'received',
        header: t('order.columns.received'),
        value: (row) => t('order.unitsOf', { count: row.receivedQuantity }),
      },
    ],
    [t, format],
  );

  const receiptColumns = useMemo<GridColumn<GoodsReceiptSummary>[]>(
    () => [
      {
        id: 'reference',
        header: t('receipts.columns.reference'),
        value: (row) => row.reference,
        hideable: false,
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
      { id: 'place', header: t('receipts.columns.place'), value: (row) => row.locationName },
      {
        id: 'total',
        header: t('receipts.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
    ],
    [t, format],
  );
  const receiptActions: GridAction<GoodsReceiptSummary>[] = [
    {
      id: 'open',
      label: t('receipts.open'),
      onSelect: (row) => navigate(`/purchasing/receipts/${row.id}`),
    },
  ];

  if (order.isPending) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t('order.loading')}</p>;
  }
  if (!data) {
    const gone = isApiError(order.error) && order.error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('order.heading')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {gone ? t('order.notFound') : tCommon(errorMessageKey(order.error))}
        </p>
        <div className="flex flex-wrap gap-2">
          {!gone && (
            <Button type="button" onClick={() => void order.refetch()}>
              {t('retry')}
            </Button>
          )}
          <Link to="/purchasing" className={buttonVariants({ variant: 'outline' })}>
            {t('order.back')}
          </Link>
        </div>
      </div>
    );
  }

  // Whoever drafted, last changed or submitted it does not approve it (the API refuses it too).
  const own =
    me !== undefined &&
    (data.submittedById === me || data.createdById === me || data.editedById === me);
  // A panel opened starts afresh: an earlier step's refusal no longer stands beside it.
  const openPanel = (next: Panel) => {
    step.reset();
    setPanel(next);
  };
  const go = (next: 'submit' | 'approve') => {
    if (step.isPending || (next === 'approve' && own)) return;
    step.reset();
    step.mutate(
      { order: data, step: next },
      {
        onSuccess: (moved) =>
          say(
            t(next === 'submit' ? 'order.submitDone' : 'order.approveDone', {
              reference: moved.reference,
            }),
          ),
        onError: () => focusIfLost(status.current),
      },
    );
  };
  const receivable = data.status === 'approved' || data.status === 'partly_received';

  return (
    <div ref={box} className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('order.headingOf', { reference: data.reference })}
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
      {stepFailure && (
        <p role="alert" className="text-sm text-destructive">
          {stepFailure}
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-[auto_1fr]">
        <dt className="font-medium">{t('order.statusLabel')}</dt>
        <dd>{t(`status.${data.status}`)}</dd>
        <dt className="font-medium">{t('order.supplier')}</dt>
        <dd>{data.supplierName}</dd>
        <dt className="font-medium">{t('order.place')}</dt>
        <dd>{data.locationName}</dd>
        <dt className="font-medium">{t('order.drafted')}</dt>
        <dd>
          {t('order.by', { name: data.createdByName, time: format.dateTime(data.createdAt) })}
        </dd>
        {data.submittedAt && (
          <>
            <dt className="font-medium">{t('order.submitted')}</dt>
            <dd>
              {t('order.by', {
                name: data.submittedByName ?? '',
                time: format.dateTime(data.submittedAt),
              })}
            </dd>
          </>
        )}
        {data.approvedAt && (
          <>
            <dt className="font-medium">{t('order.approved')}</dt>
            <dd>
              {t('order.by', {
                name: data.approvedByName ?? '',
                time: format.dateTime(data.approvedAt),
              })}
            </dd>
          </>
        )}
        {data.endedAt && (
          <>
            <dt className="font-medium">{t(`status.${data.status}`)}</dt>
            <dd>
              {t('order.endedBy', {
                name: data.endedByName ?? '',
                time: format.dateTime(data.endedAt),
                note: data.endNote ?? '',
              })}
            </dd>
          </>
        )}
        {data.note && (
          <>
            <dt className="font-medium">{t('order.note')}</dt>
            <dd className="break-words">{data.note}</dd>
          </>
        )}
      </dl>
      <p className="font-semibold">{t('order.total', { total: format.money(data.totalMinor) })}</p>
      {!panel && (
        <div className="flex flex-wrap gap-2">
          {data.status === 'draft' && canCreate && (
            <>
              <Link
                to={`/purchasing/orders/${data.id}/edit`}
                className={buttonVariants({ variant: 'outline' })}
              >
                {t('order.edit')}
              </Link>
              <Button
                type="button"
                aria-disabled={step.isPending || undefined}
                onClick={() => go('submit')}
              >
                {t('order.submit')}
              </Button>
            </>
          )}
          {data.status === 'submitted' && canApprove && (
            <Button
              type="button"
              aria-disabled={own || step.isPending || undefined}
              aria-describedby={own ? ownId : undefined}
              onClick={() => go('approve')}
            >
              {t('order.approve')}
            </Button>
          )}
          {receivable && (
            <Can permission="goodsReceipt:create">
              <Button type="button" onClick={() => openPanel('receive')}>
                {t('order.receive')}
              </Button>
            </Can>
          )}
          {['draft', 'submitted', 'approved'].includes(data.status) && canCreate && (
            <Button type="button" variant="outline" onClick={() => openPanel('cancel')}>
              {t('order.cancel')}
            </Button>
          )}
          {data.status === 'partly_received' && canCreate && (
            <Button type="button" variant="outline" onClick={() => openPanel('close')}>
              {t('order.closeOrder')}
            </Button>
          )}
        </div>
      )}
      {data.status === 'submitted' && canApprove && own && (
        <p id={ownId} className="text-sm text-muted-foreground">
          {t('order.ownHint')}
        </p>
      )}
      {panel === 'receive' && canReceive && receivable && (
        <ReceivePanel
          order={data}
          onClose={() => setPanel(null)}
          onReceived={(receipt) => {
            setPanel(null);
            say(t('receive.done', { reference: receipt.reference }));
          }}
        />
      )}
      {(panel === 'cancel' || panel === 'close') && canCreate && (
        <EndOrderPanel
          order={data}
          step={panel}
          onClose={() => setPanel(null)}
          onDone={(ended) => {
            setPanel(null);
            say(t(`order.end.${panel}Done`, { reference: ended.reference }));
          }}
        />
      )}
      <DataGrid
        label={t('order.lines')}
        columns={columns}
        rows={data.lines}
        rowId={(row) => row.id}
        rowLabel={(row) => row.itemName}
        status="ready"
        emptyMessage={t('order.noLines')}
      />
      <section aria-labelledby={receiptsId} className="flex flex-col gap-2">
        <h2 id={receiptsId} className="text-lg font-semibold">
          {t('order.receipts')}
        </h2>
        <DataGrid
          label={t('order.receipts')}
          columns={receiptColumns}
          rows={receiptRows}
          rowId={(row) => row.id}
          rowLabel={(row) => row.reference}
          actions={receiptActions}
          status={receipts.isPending ? 'loading' : receipts.isError ? 'error' : 'ready'}
          errorMessage={receipts.isError ? tCommon(errorMessageKey(receipts.error)) : undefined}
          onRetry={() => void receipts.refetch()}
          emptyMessage={t('order.noReceipts')}
          hasNextPage={receipts.hasNextPage && !receipts.isPlaceholderData}
          loadingMore={receipts.isFetchingNextPage}
          onLoadMore={() => void receipts.fetchNextPage()}
        />
      </section>
    </div>
  );
}
