import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReadingLines } from '../hooks/use-reading-lines';
import type { Flag } from '../schemas';
import type { Vitals, VitalRanges } from '../types';

type Ranges = VitalRanges['ranges'];

/** High or low, as a word with an icon: never colour alone. */
export function FlagMark({ flag }: { flag: Flag }) {
  const { t } = useTranslation('triage');
  const Icon = flag === 'high' ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 text-xs font-medium text-red-900">
      <Icon aria-hidden className="size-3" />
      {t(`flag.${flag}`)}
    </span>
  );
}

/** A reading as a list of what was measured. */
export function ReadingList({ reading, ranges }: { reading: Vitals; ranges: Ranges | undefined }) {
  const { t } = useTranslation('triage');
  const lines = useReadingLines()(reading, ranges);
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {lines.map((line) => (
        <div
          key={line.id}
          className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-1"
        >
          <dt className="text-sm text-muted-foreground">{t(`measures.${line.id}`)}</dt>
          <dd className="flex items-center gap-1.5 font-medium">
            {line.text}
            {line.flag && <FlagMark flag={line.flag} />}
          </dd>
        </div>
      ))}
      {reading.chiefComplaint && (
        <div className="sm:col-span-2">
          <dt className="text-sm text-muted-foreground">{t('summary.complaint')}</dt>
          <dd className="whitespace-pre-line break-words">{reading.chiefComplaint}</dd>
        </div>
      )}
    </dl>
  );
}

/** What the screen says when no reading of this patient is marked high or low, and why. */
export function RangesNote({ ranges, failed }: { ranges: Ranges | undefined; failed: boolean }) {
  const { t } = useTranslation('triage');
  if (failed) return <p className="text-sm text-muted-foreground">{t('rangesError')}</p>;
  if (ranges === null) return <p className="text-sm text-muted-foreground">{t('adultsOnly')}</p>;
  return null;
}
