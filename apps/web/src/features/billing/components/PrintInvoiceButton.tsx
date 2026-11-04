import { Fragment, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { Letterhead, useFormatters } from '@/tenancy';
import { useInvoicePrinting } from '../hooks/use-billing';
import { bpToPercent, taxByRate } from '../lib/tax';
import type { Invoice } from '../types';

/**
 * "Print invoice" (#110), for `invoice:print`: the invoice read afresh, the print recorded on the
 * server (the audit log), and only then the browser's print dialog. A refusal prints nothing and
 * says why under the button.
 */
export function PrintInvoiceButton({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const errorId = useId();
  const printing = useInvoicePrinting(invoiceId);
  const refusal = (error: unknown) =>
    isApiError(error) && error.serverCode === 'not_printable'
      ? t('print.notPrintable')
      : tCommon(errorMessageKey(error));
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        aria-disabled={printing.busy || undefined}
        aria-describedby={printing.error ? errorId : undefined}
        onClick={printing.print}
      >
        {t('print.action')}
      </Button>
      {printing.error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {refusal(printing.error)}
        </p>
      )}
      {printing.job && (
        <PrintSheet key={printing.job.id} onDone={printing.done}>
          <InvoiceDocument invoice={printing.job.value} />
        </PrintSheet>
      )}
    </div>
  );
}

/**
 * The invoice on paper: the hospital's letterhead, its number and date, who it is for, each line,
 * the total, what was paid and credited and what is still due, and who printed it and when.
 */
function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation('billing');
  const format = useFormatters();
  const printedBy = useSession()?.user.name ?? '';
  const due = Math.max(0, invoice.totalMinor - invoice.creditedMinor - invoice.paidMinor);
  const cell = 'border-b border-black/40 py-1 pr-3 text-left align-top';
  const amount = `${cell} text-right tabular-nums`;
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">
        {t('print.title', { number: invoice.number ?? '' })}
      </h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('print.patient')}</dt>
        <dd>{t('new.patient', { name: invoice.patientName, mrn: invoice.patientMrn })}</dd>
        <dt className="font-medium">{t('detail.issued')}</dt>
        <dd>{format.dateTime(invoice.issuedAt ?? invoice.createdAt)}</dd>
      </dl>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={cell}>
              {t('charges.columns.description')}
            </th>
            <th scope="col" className={amount}>
              {t('charges.columns.quantity')}
            </th>
            <th scope="col" className={amount}>
              {t('charges.columns.unitPrice')}
            </th>
            <th scope="col" className={amount}>
              {t('charges.columns.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id} className="break-inside-avoid">
              <th scope="row" className={`${cell} font-normal`}>
                {line.description}
              </th>
              <td className={amount}>{format.number(line.quantity)}</td>
              <td className={amount}>{format.money(line.unitPriceMinor)}</td>
              <td className={amount}>{format.money(line.totalMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-4 ml-auto grid w-72 grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
        {invoice.taxMinor > 0 && (
          <>
            <dt>{t('tax.beforeTax')}</dt>
            <dd className="text-right">{format.money(invoice.totalMinor - invoice.taxMinor)}</dd>
            {taxByRate(invoice.lines).map((each) => (
              <Fragment key={each.rateBp}>
                <dt>{t('tax.taxAt', { rate: bpToPercent(each.rateBp) })}</dt>
                <dd className="text-right">{format.money(each.taxMinor)}</dd>
              </Fragment>
            ))}
          </>
        )}
        <dt className="font-semibold">{t('builder.total')}</dt>
        <dd className="text-right font-semibold">{format.money(invoice.totalMinor)}</dd>
        {invoice.creditedMinor > 0 && (
          <>
            <dt>{t('print.credited')}</dt>
            <dd className="text-right">{format.money(invoice.creditedMinor)}</dd>
          </>
        )}
        <dt>{t('print.paid')}</dt>
        <dd className="text-right">{format.money(invoice.paidMinor)}</dd>
        <dt className="font-semibold">{t('print.due')}</dt>
        <dd className="text-right font-semibold">{format.money(due)}</dd>
      </dl>
      <p className="mt-8 border-t border-black pt-2 text-xs">
        {t('print.printedBy', {
          time: format.dateTime(new Date().toISOString()),
          name: printedBy,
        })}
      </p>
    </>
  );
}
