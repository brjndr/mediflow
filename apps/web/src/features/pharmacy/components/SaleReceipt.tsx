import { useTranslation } from 'react-i18next';
import { Letterhead, useFormatters } from '@/tenancy';
import type { PharmacySale } from '../types';

/**
 * The receipt of a counter sale (#101): the hospital's letterhead, who it was for (when anyone was
 * named), the outside prescription it was sold against, each line with its batch, expiry, units
 * and price, the total, what was returned, and who sold it when. Drawn by `PrintSheet`.
 */
export function SaleReceipt({ sale }: { sale: PharmacySale }) {
  const { t } = useTranslation('pharmacy');
  const format = useFormatters();
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{t('receipt.title')}</h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('receipt.sold')}</dt>
        <dd>
          {t('saleDetail.soldBy', {
            name: sale.soldByName,
            place: sale.locationName,
            time: format.dateTime(sale.soldAt),
          })}
        </dd>
        {sale.patientName && (
          <>
            <dt className="font-medium">{t('receipt.patient')}</dt>
            <dd>{t('detail.patient', { name: sale.patientName, mrn: sale.patientMrn })}</dd>
          </>
        )}
        {sale.prescriberName && (
          <>
            <dt className="font-medium">{t('receipt.prescription')}</dt>
            <dd>
              {t('saleDetail.prescription', {
                name: sale.prescriberName,
                registration: sale.prescriberRegistration,
                date: format.calendarDate(sale.prescribedOn ?? ''),
              })}
            </dd>
          </>
        )}
      </dl>
      <table className="mb-6 w-full border-collapse text-left">
        <thead>
          <tr className="border-b">
            <th className="py-1 pr-4 font-medium">{t('saleDetail.columns.item')}</th>
            <th className="py-1 pr-4 font-medium">{t('saleDetail.columns.batch')}</th>
            <th className="py-1 pr-4 font-medium">{t('saleDetail.columns.units')}</th>
            <th className="py-1 font-medium">{t('saleDetail.columns.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((line) => (
            <tr key={line.id} className="border-b">
              <td className="py-1 pr-4">{line.itemName}</td>
              <td className="py-1 pr-4">
                {t('saleDetail.batch', {
                  number: line.batchNumber,
                  expiry: format.calendarDate(line.expiryDate),
                })}
              </td>
              <td className="py-1 pr-4">
                {t('saleDetail.unitsAt', {
                  count: line.quantity,
                  price: format.money(Number(line.unitPriceMinor)),
                })}
              </td>
              <td className="py-1">{format.money(Number(line.unitPriceMinor) * line.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="font-semibold">
        {t('saleDetail.total', { total: format.money(Number(sale.totalMinor)) })}
      </p>
      {sale.returnedMinor !== '0' && (
        <p>{t('saleDetail.returned', { total: format.money(Number(sale.returnedMinor)) })}</p>
      )}
    </>
  );
}
