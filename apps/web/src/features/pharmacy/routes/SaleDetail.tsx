import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button, buttonVariants } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { PharmacyLinks } from '../components/PharmacyLinks';
import { SaleReceipt } from '../components/SaleReceipt';
import { SaleReturnPanel } from '../components/SaleReturnPanel';
import { usePrintReceipt, useSale } from '../hooks/use-sales';
import type { SaleLine } from '../types';

/**
 * A counter sale (`pharmacy/sales/:saleId`, #101), for `sale:read`: who it was for, the outside
 * prescription it was sold against, its lines with their batches, units, prices and what was
 * returned, its total and its returns. **Return items** (`sale:return`) opens a panel in place;
 * **Print receipt** records the print, then prints. Works at every width.
 */
export default function SaleDetail() {
  const { saleId = '' } = useParams();
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const location = useLocation();
  const sale = useSale(saleId);
  const data = sale.data;
  const mayReturn = usePermission('sale:return');
  const printErrorId = useId();
  const returnsId = useId();

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  // Arriving from the sale just made, it says so.
  const sold = (location.state as { sold?: boolean } | null)?.sold === true;
  const [message, setMessage] = useState({ text: sold ? t('sale.done') : '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);
  const [returning, setReturning] = useState(false);
  usePanelFocus(returning ? 'return' : null, box, status);
  const printing = usePrintReceipt();

  const columns = useMemo<GridColumn<SaleLine>[]>(
    () => [
      {
        id: 'item',
        header: t('saleDetail.columns.item'),
        value: (row) => row.itemName,
        hideable: false,
      },
      {
        id: 'batch',
        header: t('saleDetail.columns.batch'),
        value: (row) =>
          t('saleDetail.batch', {
            number: row.batchNumber,
            expiry: format.calendarDate(row.expiryDate),
          }),
      },
      {
        id: 'units',
        header: t('saleDetail.columns.units'),
        value: (row) =>
          t('saleDetail.unitsAt', {
            count: row.quantity,
            price: format.money(Number(row.unitPriceMinor)),
          }),
      },
      {
        id: 'amount',
        header: t('saleDetail.columns.amount'),
        value: (row) => format.money(Number(row.unitPriceMinor) * row.quantity),
      },
      {
        id: 'returned',
        header: t('saleDetail.columns.returned'),
        value: (row) => t('saleDetail.returnedUnits', { count: row.returnedQuantity }),
      },
    ],
    [t, format],
  );

  if (sale.isPending) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t('saleDetail.loading')}</p>;
  }
  if (sale.isError && !data) {
    const gone = isApiError(sale.error) && sale.error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('saleDetail.heading')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {gone ? t('saleDetail.notFound') : tCommon(errorMessageKey(sale.error))}
        </p>
        <div className="flex flex-wrap gap-2">
          {!gone && (
            <Button type="button" onClick={() => void sale.refetch()}>
              {t('retry')}
            </Button>
          )}
          <Link to="/pharmacy/sales" className={buttonVariants({ variant: 'outline' })}>
            {t('saleDetail.back')}
          </Link>
        </div>
      </div>
    );
  }
  if (!data) return null;
  const canReturn = data.lines.some((line) => line.quantity > line.returnedQuantity);

  return (
    <div ref={box} className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <PharmacyLinks />
      <h1 className="text-2xl font-semibold tracking-tight">{t('saleDetail.heading')}</h1>
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none"
      >
        {message.text}
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-[auto_1fr]">
        <dt className="font-medium">{t('receipt.sold')}</dt>
        <dd>
          {t('saleDetail.soldBy', {
            name: data.soldByName,
            place: data.locationName,
            time: format.dateTime(data.soldAt),
          })}
        </dd>
        <dt className="font-medium">{t('receipt.patient')}</dt>
        <dd>
          {data.patientName
            ? t('detail.patient', {
                name: data.patientName,
                mrn: maskMrn(data.patientMrn ?? ''),
              })
            : t('sales.walkIn')}
        </dd>
        {data.prescriberName && (
          <>
            <dt className="font-medium">{t('receipt.prescription')}</dt>
            <dd>
              {t('saleDetail.prescription', {
                name: data.prescriberName,
                registration: data.prescriberRegistration,
                date: format.calendarDate(data.prescribedOn ?? ''),
              })}
            </dd>
          </>
        )}
      </dl>
      <p className="font-semibold">
        {t('saleDetail.total', { total: format.money(Number(data.totalMinor)) })}
        {data.returnedMinor !== '0' &&
          ` ${t('saleDetail.returned', { total: format.money(Number(data.returnedMinor)) })}`}
      </p>
      {printing.error && (
        <p id={printErrorId} role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(printing.error))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          aria-disabled={printing.busy || undefined}
          aria-describedby={printing.error ? printErrorId : undefined}
          onClick={() => {
            if (!printing.busy) printing.print(data);
          }}
        >
          {t('saleDetail.print')}
        </Button>
        <Can permission="sale:return">
          {!returning && (
            <Button
              type="button"
              variant="outline"
              aria-disabled={!canReturn || undefined}
              onClick={() => {
                if (canReturn) setReturning(true);
              }}
            >
              {t('saleDetail.returnItems')}
            </Button>
          )}
        </Can>
      </div>
      {returning && mayReturn && (
        <SaleReturnPanel
          sale={data}
          onClose={() => setReturning(false)}
          onReturned={() => {
            setReturning(false);
            say(t('sale.return.done'));
          }}
        />
      )}
      <DataGrid
        label={t('saleDetail.lines')}
        columns={columns}
        rows={data.lines}
        rowId={(row) => row.id}
        rowLabel={(row) => row.itemName}
        status="ready"
        emptyMessage={t('saleDetail.noLines')}
      />
      <section aria-labelledby={returnsId} className="flex flex-col gap-2">
        <h2 id={returnsId} className="text-lg font-semibold">
          {t('saleDetail.returns')}
        </h2>
        {data.returns.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('saleDetail.noReturns')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.returns.map((each) => (
              <li key={each.id} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                <p className="font-medium">
                  {t('saleDetail.returnLine', {
                    total: format.money(Number(each.totalMinor)),
                    reason: each.reason,
                  })}
                </p>
                <p className="text-muted-foreground">
                  {t('saleDetail.returnedBy', {
                    name: each.returnedByName,
                    time: format.dateTime(each.returnedAt),
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {printing.job && (
        <PrintSheet key={printing.job.id} onDone={printing.done}>
          <SaleReceipt sale={printing.job.sale} />
        </PrintSheet>
      )}
    </div>
  );
}
