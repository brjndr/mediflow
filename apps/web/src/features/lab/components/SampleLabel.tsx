import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';
import { code128Bars } from '../code128';
import type { LabSample, LabWorkItem } from '../types';

/** The label's size: a common tube label, 50 by 25 mm. */
const PAGE = '@page { size: 50mm 25mm; margin: 0; }';
/** The width of one barcode module on paper. */
const MODULE_MM = 0.25;

/**
 * A sample's label (#90), printed on a label printer: the accession id as a Code 128 barcode and
 * in words, who the sample is from (name, MRN, date of birth), the test, the sample and its
 * container, and when it was collected. Black on white at the label's own size.
 */
export function SampleLabel({ item, sample }: { item: LabWorkItem; sample: LabSample }) {
  const { t } = useTranslation('lab');
  const format = useFormatters();
  const { bars, width } = code128Bars(sample.accessionId);
  return (
    <div className="flex h-[25mm] w-[50mm] flex-col justify-between overflow-hidden p-[1.5mm] text-[7pt] leading-tight">
      <style>{PAGE}</style>
      <p className="truncate font-semibold">{item.patientName}</p>
      <p className="truncate">
        {[
          item.patientMrn,
          item.patientDob ? t('label.dob', { day: format.calendarDate(item.patientDob) }) : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {/* A module is 0.25 mm, two dots of a 203 dpi label printer, so every bar has the same
          width on paper and scans: an accession id is 176 modules, 44 mm. */}
      <svg
        viewBox={`0 0 ${width} 30`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        style={{ width: `${width * MODULE_MM}mm` }}
        className="h-[8mm] max-w-full self-center"
        role="img"
        aria-label={t('label.barcode', { id: sample.accessionId })}
      >
        {bars.map((bar) => (
          <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={30} fill="#000" />
        ))}
      </svg>
      <p className="font-mono font-semibold tracking-wider">{sample.accessionId}</p>
      <p className="truncate">
        {[
          item.itemCode ?? item.itemName,
          t(`sampleType.${sample.sampleType}`),
          sample.container ?? '',
          format.dateTime(sample.collectedAt),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </div>
  );
}
