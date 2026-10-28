import { useTranslation } from 'react-i18next';
import { Letterhead, useFormatters } from '@/tenancy';
import { useItemName } from '../hooks/use-item-name';
import type { StockIndent, StockIssue } from '../types';

/**
 * An issue voucher as printed (#105), to go with the goods: the hospital's letterhead, the
 * voucher and its indent, from the store to the place that asked, who issued it and when, and
 * each batch with its expiry and units, with room for the receiver to sign. Drawn by `PrintSheet`.
 */
export function IssueVoucher({ indent, issue }: { indent: StockIndent; issue: StockIssue }) {
  const { t } = useTranslation('indents');
  const format = useFormatters();
  const nameOf = useItemName();
  const lineOf = (lineId: string) => indent.lines.find((line) => line.id === lineId);
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">
        {t('voucher.title', { reference: issue.reference })}
      </h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('voucher.indent')}</dt>
        <dd>{indent.reference}</dd>
        <dt className="font-medium">{t('detail.from')}</dt>
        <dd>{indent.fromLocationName}</dd>
        <dt className="font-medium">{t('detail.to')}</dt>
        <dd>{indent.toLocationName}</dd>
        <dt className="font-medium">{t('voucher.issued')}</dt>
        <dd>{t('by', { name: issue.issuedByName, time: format.dateTime(issue.issuedAt) })}</dd>
        {issue.note && (
          <>
            <dt className="font-medium">{t('detail.note')}</dt>
            <dd>{issue.note}</dd>
          </>
        )}
      </dl>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-4">{t('voucher.item')}</th>
            <th className="py-1 pr-4">{t('voucher.batch')}</th>
            <th className="py-1 pr-4">{t('voucher.expiry')}</th>
            <th className="py-1 text-right">{t('voucher.units')}</th>
          </tr>
        </thead>
        <tbody>
          {issue.lines.map((line) => {
            const indentLine = lineOf(line.indentLineId);
            return (
              <tr key={`${line.indentLineId}:${line.batchId}`} className="border-b">
                <td className="py-1 pr-4">{indentLine ? nameOf(indentLine.item) : ''}</td>
                <td className="py-1 pr-4">{line.batchNumber}</td>
                <td className="py-1 pr-4">{format.calendarDate(line.expiryDate)}</td>
                <td className="py-1 text-right">{line.quantity}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-12">{t('voucher.received')}</p>
    </>
  );
}
