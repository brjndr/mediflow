import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { InvoiceBuilder } from '../components/InvoiceBuilder';
import { CreditNotePanel } from '../components/CreditNotePanel';
import { PaymentPanel } from '../components/PaymentPanel';
import { PrintInvoiceButton } from '../components/PrintInvoiceButton';
import { useInvoice } from '../hooks/use-billing';
import { bpToPercent } from '../lib/tax';
import type { Invoice, InvoiceLine } from '../types';

/** An id from the address, or empty when it is not one. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One invoice (`billing/invoices/:invoiceId`, #109), for `invoice:read`. A draft is the builder,
 * to change and issue; an issued invoice is read-only, with its number, lines and total (the
 * list, the print view and payments are #110 and #111).
 */
export default function InvoiceDetail() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const raw = useParams().invoiceId ?? '';
  const invoiceId = ID.test(raw) ? raw : '';
  const invoice = useInvoice(invoiceId);
  const missing =
    invoiceId === '' ||
    (isApiError(invoice.error) && (invoice.error.status === 404 || invoice.error.status === 403));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('detail.heading')}</h1>
      {missing ? (
        <p role="alert" className="text-sm">
          {t('detail.unavailable')}
        </p>
      ) : invoice.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : invoice.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(invoice.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void invoice.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <Body invoice={invoice.data} />
      )}
    </div>
  );
}

function Body({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation('billing');
  // Set by the builder after the first save of a draft: fixed words, never the record.
  const state: unknown = useLocation().state;
  const justSaved =
    typeof state === 'object' && state !== null && 'saved' in state && state.saved === true;
  const format = useFormatters();
  const canCreate = usePermission('invoice:create');
  const canReadEncounter = usePermission('encounter:read');
  const draft = invoice.status === 'draft';

  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="text-lg font-medium">
          {t('new.patient', { name: invoice.patientName, mrn: invoice.patientMrn })}
        </p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('detail.status')}</dt>
          <dd className="font-medium">{t(`status.${invoice.status}`)}</dd>
          {invoice.number && (
            <>
              <dt className="text-muted-foreground">{t('detail.number')}</dt>
              <dd>{invoice.number}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('detail.created')}</dt>
          <dd>{format.dateTime(invoice.createdAt)}</dd>
          {invoice.issuedAt && (
            <>
              <dt className="text-muted-foreground">{t('detail.issued')}</dt>
              <dd>{format.dateTime(invoice.issuedAt)}</dd>
            </>
          )}
        </dl>
        <div className="mt-1 flex flex-wrap items-start gap-2">
          {(invoice.status === 'issued' || invoice.status === 'paid') && (
            <Can permission="invoice:print">
              <PrintInvoiceButton invoiceId={invoice.id} />
            </Can>
          )}
          {canReadEncounter && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/encounters/${invoice.encounterId}`}>{t('detail.openVisit')}</Link>
            </Button>
          )}
        </div>
      </div>
      {draft && canCreate ? (
        <InvoiceBuilder
          encounterId={invoice.encounterId}
          invoice={invoice}
          notice={justSaved ? t('builder.saved') : ''}
        />
      ) : (
        <>
          <Issued invoice={invoice} />
          {invoice.status !== 'draft' && <PaymentPanel invoice={invoice} />}
          {invoice.status !== 'draft' && <CreditNotePanel invoice={invoice} />}
        </>
      )}
    </>
  );
}

/** An invoice that can no longer be changed: its lines and total. */
function Issued({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation('billing');
  const format = useFormatters();
  const status = useRef<HTMLParagraphElement>(null);
  // The builder's buttons are gone once the invoice is issued: focus moves to what happened.
  useLayoutEffect(() => {
    focusIfLost(status.current);
  }, []);
  const columns = useMemo<GridColumn<InvoiceLine>[]>(
    () => [
      {
        id: 'description',
        header: t('charges.columns.description'),
        value: (row) => row.description,
      },
      {
        id: 'quantity',
        header: t('charges.columns.quantity'),
        value: (row) => row.quantity,
        align: 'end',
      },
      {
        id: 'unitPrice',
        header: t('charges.columns.unitPrice'),
        value: (row) => format.money(row.unitPriceMinor),
        align: 'end',
      },
      {
        id: 'amount',
        header: t('charges.columns.amount'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      ...(invoice.taxMinor > 0
        ? [
            {
              id: 'tax',
              header: t('tax.tax'),
              value: (row: InvoiceLine) =>
                row.taxRateBp > 0
                  ? t('tax.lineTax', {
                      amount: format.money(row.taxMinor),
                      rate: bpToPercent(row.taxRateBp),
                    })
                  : t('tax.none'),
              align: 'end' as const,
            },
          ]
        : []),
    ],
    [t, format, invoice.taxMinor],
  );
  return (
    <section aria-labelledby="lines-heading" className="flex flex-col gap-3">
      <h2 id="lines-heading" className="text-lg font-semibold">
        {t('detail.lines')}
      </h2>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {invoice.status === 'draft'
          ? t('detail.draftReadOnly')
          : t('detail.locked', {
              number: invoice.number ?? '',
              time: format.dateTime(invoice.issuedAt ?? invoice.createdAt),
            })}
      </p>
      <DataGrid
        label={t('detail.lines')}
        columns={columns}
        rows={invoice.lines}
        rowId={(row) => row.id}
        rowLabel={(row) => row.description}
        status="ready"
        emptyMessage={t('detail.noLines')}
      />
      {invoice.taxMinor > 0 && (
        <dl className="grid max-w-xs grid-cols-2 gap-x-4 text-sm">
          <dt className="text-muted-foreground">{t('tax.beforeTax')}</dt>
          <dd className="text-right" data-testid="invoice-subtotal">
            {format.money(invoice.totalMinor - invoice.taxMinor)}
          </dd>
          <dt className="text-muted-foreground">{t('tax.tax')}</dt>
          <dd className="text-right" data-testid="invoice-tax">
            {format.money(invoice.taxMinor)}
          </dd>
        </dl>
      )}
      <p className="text-2xl font-semibold" data-testid="invoice-total">
        <span className="sr-only">{t('builder.total')}: </span>
        {format.money(invoice.totalMinor)}
      </p>
      {invoice.status !== 'draft' && (
        <p className="text-sm text-muted-foreground">
          {t('detail.paidSummary', {
            paid: format.money(invoice.paidMinor),
            total: format.money(invoice.totalMinor),
            credited: format.money(invoice.creditedMinor),
          })}
        </p>
      )}
    </section>
  );
}
