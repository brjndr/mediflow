import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { DepositPanel } from '../components/DepositPanel';
import { EstimatePanel } from '../components/EstimatePanel';
import { useRunningBill } from '../hooks/use-stay-bill';
import type { RunningBillLine } from '../stay-bill';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The running bill of an inpatient stay (`billing/stays/:admissionId`, DS-03, #166), for
 * `admission:read` and `charge:read`: the charge ledger of the stay added up by what it was for,
 * the bed days so far, the deposits, what was paid and the balance, with the estimate beside the
 * actual. An interim bill is made from the same charges in the invoice builder. The address holds
 * the admission's id and nothing about the patient.
 */
export default function StayBill() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const raw = useParams().admissionId ?? '';
  const admissionId = ID.test(raw) ? raw : '';
  const found = useRunningBill(admissionId);
  const bill = found.data;
  const canInvoice = usePermission('invoice:create');
  const missing =
    admissionId === '' ||
    (found.isError && isApiError(found.error) && [403, 404].includes(found.error.status ?? 0));

  const columns = useMemo<GridColumn<RunningBillLine>[]>(
    () => [
      {
        id: 'source',
        header: t('stay.columns.source'),
        value: (row) =>
          row.accruing ? t('stay.sources.bedAccruing') : t(`stay.sources.${row.source}`),
      },
      { id: 'count', header: t('stay.columns.count'), value: (row) => String(row.count) },
      {
        id: 'total',
        header: t('stay.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('stay.heading')}</h1>
      <Link
        to="/admissions"
        className="inline-flex w-fit items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
      >
        {t('stay.back')}
      </Link>
      {missing ? (
        <p role="alert">{t('stay.unavailable')}</p>
      ) : found.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : found.isError || !bill ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(found.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void found.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-lg font-medium">
            {t('new.patient', { name: bill.patientName, mrn: bill.patientMrn })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('stay.asOf', { time: format.dateTime(bill.asOf) })}
            {bill.status === 'discharged' ? ` ${t('stay.discharged')}` : ''}
          </p>
          <DataGrid
            label={t('stay.heading')}
            columns={columns}
            rows={bill.lines}
            rowId={(row) => `${row.source}${row.accruing ? ':accruing' : ''}`}
            rowLabel={(row) => format.money(row.totalMinor)}
            status="ready"
            emptyMessage={t('stay.none')}
          />
          <dl
            className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm"
            aria-label={t('stay.totals')}
          >
            <dt className="font-medium">{t('stay.charges')}</dt>
            <dd className="text-end" data-testid="charges-total">
              {format.money(bill.chargesMinor)}
            </dd>
            <dt>{t('stay.invoiced')}</dt>
            <dd className="text-end">{format.money(bill.invoicedMinor)}</dd>
            <dt>{t('stay.paid')}</dt>
            <dd className="text-end">{format.money(bill.paidMinor)}</dd>
            <dt>{t('stay.deposits')}</dt>
            <dd className="text-end" data-testid="deposits-total">
              {format.money(bill.depositsMinor)}
            </dd>
            <dt className="font-semibold">
              {bill.balanceMinor < 0 ? t('stay.credit') : t('stay.balance')}
            </dt>
            <dd className="text-end font-semibold" data-testid="balance">
              {format.money(Math.abs(bill.balanceMinor))}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">{t('stay.bedNote')}</p>
          {canInvoice && (
            <div>
              <Button asChild variant="outline">
                <Link to={`/billing/new?encounterId=${bill.encounterId}`}>{t('stay.interim')}</Link>
              </Button>
            </div>
          )}
          <EstimatePanel bill={bill} />
          <DepositPanel admissionId={bill.admissionId} open={bill.status === 'admitted'} />
        </>
      )}
    </div>
  );
}
