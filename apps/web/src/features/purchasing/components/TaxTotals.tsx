import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';

interface Props {
  /** The lines at their unit costs, before tax. */
  totalMinor: number;
  taxMinor: number;
  /** How the tax divides, when the document says: CGST and SGST, IGST, or not known. */
  split?: {
    supply: 'intra_state' | 'inter_state' | 'unknown';
    cgstMinor?: number;
    sgstMinor?: number;
    igstMinor?: number;
  };
}

/**
 * A document's totals: before tax, the GST (split into CGST and SGST for a supplier in the
 * hospital's state, IGST from another, one amount when a GSTIN is missing) and the total with
 * tax. Each amount is a term with its value, so a screen reader reads them as pairs.
 */
export function TaxTotals({ totalMinor, taxMinor, split }: Props) {
  const { t } = useTranslation('purchasing');
  const format = useFormatters();
  const rows: [string, number][] = [[t('gst.beforeTax'), totalMinor]];
  if (split?.supply === 'intra_state') {
    rows.push([t('gst.cgst'), split.cgstMinor ?? 0], [t('gst.sgst'), split.sgstMinor ?? 0]);
  } else if (split?.supply === 'inter_state') {
    rows.push([t('gst.igst'), split.igstMinor ?? 0]);
  } else {
    rows.push([t('gst.tax'), taxMinor]);
  }
  const last = t('gst.totalWithTax');
  rows.push([last, totalMinor + taxMinor]);
  return (
    <div className="flex flex-col gap-1">
      <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, amount]) => (
          <div
            key={label}
            className={`col-span-2 grid grid-cols-subgrid ${label === last ? 'font-semibold' : ''}`}
          >
            <dt>{label}</dt>
            <dd className="text-end tabular-nums">{format.money(amount)}</dd>
          </div>
        ))}
      </dl>
      {split?.supply === 'unknown' && taxMinor > 0 && (
        <p className="text-sm text-muted-foreground">{t('gst.unknownSplit')}</p>
      )}
    </div>
  );
}
