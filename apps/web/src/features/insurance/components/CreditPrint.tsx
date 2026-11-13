import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { Letterhead, useFormatters } from '@/tenancy';
import { receiptReconciles } from '../credit';
import type { CreditStatement, Receipt, StatementLine } from '../types';

const cell = 'border-b border-black/40 py-1 pr-3 text-left align-top';
const amount = `${cell} text-right tabular-nums`;

/** A button that prints what it is given: nothing is mounted, or asked of the server, before the tap. */
export function PrintAction({
  label,
  children,
  size = 'default',
}: {
  label: string;
  children: ReactNode;
  size?: 'default' | 'sm';
}) {
  const [job, setJob] = useState(0);
  return (
    <>
      <Button type="button" variant="outline" size={size} onClick={() => setJob((n) => n + 1)}>
        {label}
      </Button>
      {job > 0 && (
        <PrintSheet key={job} onDone={() => setJob(0)}>
          {children}
        </PrintSheet>
      )}
    </>
  );
}

/** The receipt given to a corporate for money received, and the bills it was set against. */
export function ReceiptDocument({ receipt }: { receipt: Receipt }) {
  const { t } = useTranslation('insurance');
  const format = useFormatters();
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">
        {t('credit.print.receiptTitle', { number: receipt.number })}
      </h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('credit.print.from')}</dt>
        <dd>{receipt.payerName}</dd>
        <dt className="font-medium">{t('credit.receipt.date')}</dt>
        <dd>{format.calendarDate(receipt.receivedOn)}</dd>
        <dt className="font-medium">{t('credit.receipt.method')}</dt>
        <dd>{t(`credit.method.${receipt.method}`)}</dd>
        {receipt.reference !== undefined && (
          <>
            <dt className="font-medium">{t('credit.receipt.reference')}</dt>
            <dd>{receipt.reference}</dd>
          </>
        )}
        <dt className="font-medium">{t('credit.receipt.amount')}</dt>
        <dd className="font-semibold">{format.money(receipt.amountMinor)}</dd>
      </dl>
      <table className="w-full border-collapse text-sm">
        <caption className="mb-1 text-left font-medium">{t('credit.print.appliedTo')}</caption>
        <thead>
          <tr>
            <th scope="col" className={cell}>
              {t('credit.columns.number')}
            </th>
            <th scope="col" className={amount}>
              {t('credit.columns.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {receipt.allocations.map((one) => (
            <tr key={one.billId} className="break-inside-avoid">
              <th scope="row" className={`${cell} font-normal`}>
                {one.billNumber}
              </th>
              <td className={amount}>{format.money(one.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!receiptReconciles(receipt) && <p className="mt-3">{t('credit.print.notReconciled')}</p>}
    </>
  );
}

/** The statement of an account for a period, every line printed (the caller passes all pages). */
export function StatementDocument({
  statement,
  lines,
}: {
  statement: CreditStatement;
  lines: StatementLine[];
}) {
  const { t } = useTranslation('insurance');
  const format = useFormatters();
  return (
    <>
      <Letterhead />
      <h1 className="mb-1 text-lg font-semibold">{t('credit.print.statementTitle')}</h1>
      <p className="mb-3">
        {t('credit.print.period', {
          name: statement.payerName,
          from: format.calendarDate(statement.from),
          to: format.calendarDate(statement.to),
        })}
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={cell}>
              {t('credit.columns.date')}
            </th>
            <th scope="col" className={cell}>
              {t('credit.columns.number')}
            </th>
            <th scope="col" className={amount}>
              {t('credit.columns.billed')}
            </th>
            <th scope="col" className={amount}>
              {t('credit.columns.received')}
            </th>
            <th scope="col" className={amount}>
              {t('credit.columns.balance')}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" colSpan={4} className={`${cell} font-normal`}>
              {t('credit.statement.opening')}
            </th>
            <td className={amount}>{format.money(statement.openingMinor)}</td>
          </tr>
          {lines.map((line) => (
            <tr key={line.id} className="break-inside-avoid">
              <td className={cell}>{format.calendarDate(line.on)}</td>
              <th scope="row" className={`${cell} font-normal`}>
                {line.number}
              </th>
              <td className={amount}>{line.debitMinor > 0 ? format.money(line.debitMinor) : ''}</td>
              <td className={amount}>
                {line.creditMinor > 0 ? format.money(line.creditMinor) : ''}
              </td>
              <td className={amount}>{format.money(line.balanceMinor)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" colSpan={2} className={`${cell} font-semibold`}>
              {t('credit.statement.closing')}
            </th>
            <td className={`${amount} font-semibold`}>{format.money(statement.billedMinor)}</td>
            <td className={`${amount} font-semibold`}>{format.money(statement.receivedMinor)}</td>
            <td className={`${amount} font-semibold`}>{format.money(statement.closingMinor)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
